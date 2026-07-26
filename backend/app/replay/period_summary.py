"""Strict, checksum-bound cumulative market summaries for trusted replay jumps."""

from __future__ import annotations

import hashlib
import json
import re
import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from .canonical import canonical_json_bytes, canonical_sha256
from .models import validate_counter, validate_identifier, validate_timestamp_ms


PERIOD_SUMMARY_SCHEMA_VERSION = "replay.period-summary.v1"
PERIOD_SUMMARY_ALGORITHM_VERSION = "replay.period-summary.algorithm.v1"
MAX_PERIOD_SUMMARY_RAW_STATE_BYTES = 64 * 1024 * 1024
MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES = 128 * 1024 * 1024
MAX_PERIOD_SUMMARY_CANDIDATES = 64
PERIOD_SUMMARY_YIELD_EVENTS = 64
PERIOD_SUMMARY_MIN_SKIP_EVENTS = 64
PERIOD_SUMMARY_MIN_TAIL_EVENTS = 32

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_SOURCE_KINDS = {"BAR", "AGG_TRADE"}
_CURSOR_FIELDS = {
    "source_sequence",
    "last_event_time_ms",
    "last_base_bar_open_ms",
    "at_end",
}


def _digest(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not _DIGEST.fullmatch(value):
        raise ValueError(f"{field_name} must be a SHA-256 digest")
    return value


def _optional_timestamp(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    return validate_timestamp_ms(value, field_name=field_name)


def _normalized_cursor(value: object) -> MappingProxyType[str, object]:
    if not isinstance(value, Mapping) or set(value) != _CURSOR_FIELDS:
        raise ValueError("period summary source cursor fields are incompatible")
    source_sequence = validate_counter(
        value["source_sequence"],
        field_name="end_source_cursor.source_sequence",
    )
    at_end = value["at_end"]
    if not isinstance(at_end, bool):
        raise TypeError("end_source_cursor.at_end must be a boolean")
    return MappingProxyType(
        {
            "source_sequence": source_sequence,
            "last_event_time_ms": _optional_timestamp(
                value["last_event_time_ms"],
                "end_source_cursor.last_event_time_ms",
            ),
            "last_base_bar_open_ms": _optional_timestamp(
                value["last_base_bar_open_ms"],
                "end_source_cursor.last_base_bar_open_ms",
            ),
            "at_end": at_end,
        }
    )


@dataclass(frozen=True, slots=True)
class ReplayPeriodSummary:
    """One cumulative exact-reducer candidate ending before the source tail."""

    summary_id: str
    run_id: str
    session_id: str
    source_kind: str
    data_epoch: str
    snapshot_ref_hash: str
    session_config_hash: str
    execution_version: str
    rule_revision: int
    rule_hash: str
    base_source_sequence: int
    base_domain_command_position: int
    base_event_chain_hash: str
    base_component_state_hash: str
    end_source_sequence: int
    end_virtual_time_ms: int
    end_source_cursor: Mapping[str, object]
    end_event_chain_hash: str
    end_component_state: Mapping[str, object]
    end_component_state_hash: str
    algorithm_version: str = PERIOD_SUMMARY_ALGORITHM_VERSION
    schema_version: str = PERIOD_SUMMARY_SCHEMA_VERSION
    summary_hash: str | None = None

    def __post_init__(self) -> None:
        if self.schema_version != PERIOD_SUMMARY_SCHEMA_VERSION:
            raise ValueError("period summary schema is incompatible")
        if self.algorithm_version != PERIOD_SUMMARY_ALGORITHM_VERSION:
            raise ValueError("period summary algorithm is incompatible")
        for field_name in ("summary_id", "run_id", "session_id"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        source_kind = str(self.source_kind)
        if source_kind not in _SOURCE_KINDS:
            raise ValueError("period summary source_kind is unsupported")
        object.__setattr__(self, "source_kind", source_kind)
        for field_name in (
            "data_epoch",
            "snapshot_ref_hash",
            "session_config_hash",
            "rule_hash",
            "base_event_chain_hash",
            "base_component_state_hash",
            "end_event_chain_hash",
            "end_component_state_hash",
        ):
            object.__setattr__(
                self,
                field_name,
                _digest(getattr(self, field_name), field_name),
            )
        if not isinstance(self.execution_version, str) or not self.execution_version:
            raise ValueError("execution_version cannot be blank")
        for field_name in (
            "rule_revision",
            "base_source_sequence",
            "base_domain_command_position",
            "end_source_sequence",
        ):
            value = validate_counter(getattr(self, field_name), field_name=field_name)
            object.__setattr__(self, field_name, value)
        if self.rule_revision < 1:
            raise ValueError("rule_revision must be positive")
        if self.end_source_sequence <= self.base_source_sequence:
            raise ValueError("period summary must advance the source cursor")
        end_virtual_time = validate_timestamp_ms(
            self.end_virtual_time_ms,
            field_name="end_virtual_time_ms",
        )
        object.__setattr__(self, "end_virtual_time_ms", end_virtual_time)
        cursor = _normalized_cursor(self.end_source_cursor)
        if cursor["source_sequence"] != self.end_source_sequence:
            raise ValueError("period summary end cursor sequence is inconsistent")
        if cursor["last_event_time_ms"] != end_virtual_time:
            raise ValueError("period summary end time must equal its last source event")
        if cursor["at_end"] is True:
            raise ValueError("period summary cannot replace terminal finalization")
        object.__setattr__(self, "end_source_cursor", cursor)
        if not isinstance(self.end_component_state, Mapping):
            raise TypeError("end_component_state must be an object")
        components = MappingProxyType(dict(self.end_component_state))
        if canonical_sha256(components) != self.end_component_state_hash:
            raise ValueError("period summary component state checksum does not match")
        object.__setattr__(self, "end_component_state", components)
        expected_hash = canonical_sha256(self.hash_material())
        if self.summary_hash is None:
            object.__setattr__(self, "summary_hash", expected_hash)
        elif _digest(self.summary_hash, "summary_hash") != expected_hash:
            raise ValueError("period summary canonical hash does not match")

    @property
    def event_count(self) -> int:
        return self.end_source_sequence - self.base_source_sequence

    def hash_material(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "algorithm_version": self.algorithm_version,
            "summary_id": self.summary_id,
            "run_id": self.run_id,
            "session_id": self.session_id,
            "source_kind": self.source_kind,
            "data_epoch": self.data_epoch,
            "snapshot_ref_hash": self.snapshot_ref_hash,
            "session_config_hash": self.session_config_hash,
            "execution_version": self.execution_version,
            "rule_revision": self.rule_revision,
            "rule_hash": self.rule_hash,
            "base_source_sequence": self.base_source_sequence,
            "base_domain_command_position": self.base_domain_command_position,
            "base_event_chain_hash": self.base_event_chain_hash,
            "base_component_state_hash": self.base_component_state_hash,
            "end_source_sequence": self.end_source_sequence,
            "end_virtual_time_ms": self.end_virtual_time_ms,
            "end_source_cursor": dict(self.end_source_cursor),
            "end_event_chain_hash": self.end_event_chain_hash,
            "end_component_state_hash": self.end_component_state_hash,
        }

    def to_dict(self, *, include_component_state: bool = True) -> dict[str, object]:
        payload = {
            **self.hash_material(),
            "summary_hash": self.summary_hash,
            "event_count": self.event_count,
        }
        if include_component_state:
            payload["end_component_state"] = dict(self.end_component_state)
        return payload

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayPeriodSummary":
        expected = {
            "schema_version",
            "algorithm_version",
            "summary_id",
            "run_id",
            "session_id",
            "source_kind",
            "data_epoch",
            "snapshot_ref_hash",
            "session_config_hash",
            "execution_version",
            "rule_revision",
            "rule_hash",
            "base_source_sequence",
            "base_domain_command_position",
            "base_event_chain_hash",
            "base_component_state_hash",
            "end_source_sequence",
            "end_virtual_time_ms",
            "end_source_cursor",
            "end_event_chain_hash",
            "end_component_state",
            "end_component_state_hash",
            "summary_hash",
        }
        received = set(payload)
        if received != expected and received != expected | {"event_count"}:
            raise ValueError("period summary fields are incompatible")
        normalized = dict(payload)
        declared_event_count = normalized.pop("event_count", None)
        summary = cls(**normalized)  # type: ignore[arg-type]
        if declared_event_count is not None and (
            isinstance(declared_event_count, bool)
            or not isinstance(declared_event_count, int)
            or declared_event_count != summary.event_count
        ):
            raise ValueError("period summary event count is inconsistent")
        return summary


@dataclass(frozen=True, slots=True)
class EncodedPeriodSummaryCandidate:
    """One bounded transport candidate without retaining decoded reducer state."""

    metadata: Mapping[str, object]
    component_blob: bytes
    component_raw_bytes: int
    component_blob_hash: str

    def __post_init__(self) -> None:
        if not isinstance(self.metadata, Mapping):
            raise TypeError("period summary candidate metadata must be an object")
        try:
            normalized = json.loads(canonical_json_bytes(self.metadata))
        except (TypeError, ValueError) as exc:
            raise ValueError("period summary candidate metadata is invalid") from exc
        if not isinstance(normalized, dict) or "end_component_state" in normalized:
            raise ValueError(
                "encoded period summary metadata cannot retain component state"
            )
        blob = self.component_blob
        if not isinstance(blob, bytes) or not blob:
            raise ValueError("period summary component blob must be non-empty bytes")
        raw_bytes = self.component_raw_bytes
        if (
            isinstance(raw_bytes, bool)
            or not isinstance(raw_bytes, int)
            or not 1 <= raw_bytes <= MAX_PERIOD_SUMMARY_RAW_STATE_BYTES
        ):
            raise ValueError("period summary raw byte count is invalid")
        blob_hash = _digest(
            self.component_blob_hash,
            "component_blob_hash",
        )
        if f"sha256:{hashlib.sha256(blob).hexdigest()}" != blob_hash:
            raise ValueError("period summary compressed blob checksum does not match")
        object.__setattr__(self, "metadata", MappingProxyType(normalized))
        object.__setattr__(self, "component_blob", bytes(blob))
        object.__setattr__(self, "component_raw_bytes", raw_bytes)
        object.__setattr__(self, "component_blob_hash", blob_hash)

    @classmethod
    def from_summary(
        cls,
        summary: ReplayPeriodSummary,
        *,
        component_blob: bytes,
        component_raw_bytes: int,
        component_blob_hash: str,
    ) -> "EncodedPeriodSummaryCandidate":
        if not isinstance(summary, ReplayPeriodSummary):
            raise TypeError("summary must be ReplayPeriodSummary")
        return cls(
            metadata=summary.to_dict(include_component_state=False),
            component_blob=component_blob,
            component_raw_bytes=component_raw_bytes,
            component_blob_hash=component_blob_hash,
        )

    @property
    def summary_hash(self) -> str:
        value = self.metadata.get("summary_hash")
        return _digest(value, "summary_hash")

    @property
    def summary_id(self) -> str:
        return validate_identifier(
            self.metadata.get("summary_id"),
            field_name="summary_id",
        )

    @property
    def end_source_sequence(self) -> int:
        return validate_counter(
            self.metadata.get("end_source_sequence"),
            field_name="end_source_sequence",
        )

    def decode(self) -> ReplayPeriodSummary:
        state_hash = self.metadata.get("end_component_state_hash")
        component_state = decode_component_state(
            self.component_blob,
            expected_raw_bytes=self.component_raw_bytes,
            expected_blob_hash=self.component_blob_hash,
            expected_state_hash=_digest(
                state_hash,
                "end_component_state_hash",
            ),
        )
        return ReplayPeriodSummary.from_dict(
            {
                **dict(self.metadata),
                "end_component_state": component_state,
            }
        )


def encode_component_state(
    state: Mapping[str, object],
) -> tuple[bytes, int, str, str]:
    raw = canonical_json_bytes(state)
    if len(raw) > MAX_PERIOD_SUMMARY_RAW_STATE_BYTES:
        raise ValueError("period summary component state exceeds the raw byte budget")
    compressed = zlib.compress(raw, level=9)
    return (
        compressed,
        len(raw),
        f"sha256:{hashlib.sha256(compressed).hexdigest()}",
        canonical_sha256(state),
    )


def decode_component_state(
    compressed: bytes,
    *,
    expected_raw_bytes: int,
    expected_blob_hash: str,
    expected_state_hash: str,
) -> dict[str, object]:
    if not isinstance(compressed, bytes) or not compressed:
        raise ValueError("period summary component blob must be non-empty bytes")
    if (
        isinstance(expected_raw_bytes, bool)
        or not isinstance(expected_raw_bytes, int)
        or not 1 <= expected_raw_bytes <= MAX_PERIOD_SUMMARY_RAW_STATE_BYTES
    ):
        raise ValueError("period summary raw byte count is invalid")
    if f"sha256:{hashlib.sha256(compressed).hexdigest()}" != _digest(
        expected_blob_hash,
        "component_blob_hash",
    ):
        raise ValueError("period summary compressed blob checksum does not match")

    decoder = zlib.decompressobj()
    output = bytearray()
    pending = compressed
    while pending:
        remaining_budget = MAX_PERIOD_SUMMARY_RAW_STATE_BYTES + 1 - len(output)
        if remaining_budget <= 0:
            raise ValueError("period summary component state exceeds the raw byte budget")
        output.extend(decoder.decompress(pending, remaining_budget))
        pending = decoder.unconsumed_tail
        if not pending:
            break
    remaining_budget = MAX_PERIOD_SUMMARY_RAW_STATE_BYTES + 1 - len(output)
    output.extend(decoder.flush(max(1, remaining_budget)))
    if (
        not decoder.eof
        or decoder.unused_data
        or len(output) > MAX_PERIOD_SUMMARY_RAW_STATE_BYTES
        or len(output) != expected_raw_bytes
    ):
        raise ValueError("period summary compressed component state is invalid")
    raw = bytes(output)
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("period summary component JSON is invalid") from exc
    if not isinstance(decoded, dict) or canonical_json_bytes(decoded) != raw:
        raise ValueError("period summary component JSON is not canonical")
    if canonical_sha256(decoded) != _digest(
        expected_state_hash,
        "end_component_state_hash",
    ):
        raise ValueError("period summary decoded component checksum does not match")
    return decoded


__all__ = [
    "MAX_PERIOD_SUMMARY_CANDIDATES",
    "MAX_PERIOD_SUMMARY_RAW_STATE_BYTES",
    "MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES",
    "PERIOD_SUMMARY_ALGORITHM_VERSION",
    "PERIOD_SUMMARY_MIN_SKIP_EVENTS",
    "PERIOD_SUMMARY_MIN_TAIL_EVENTS",
    "PERIOD_SUMMARY_SCHEMA_VERSION",
    "PERIOD_SUMMARY_YIELD_EVENTS",
    "EncodedPeriodSummaryCandidate",
    "ReplayPeriodSummary",
    "decode_component_state",
    "encode_component_state",
]
