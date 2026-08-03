"""Canonical replay checkpoint codec and bounded corruption-aware retention."""

from __future__ import annotations

import hashlib
import json
import zlib
from collections import deque
from dataclasses import dataclass
from typing import Callable, Mapping

from .canonical import canonical_json_bytes, canonical_sha256
from .errors import ReplayDomainError, ReplayErrorCode
from .models import validate_counter, validate_timestamp_ms


CHECKPOINT_SCHEMA_VERSION = "replay-checkpoint.v1"

# Checkpoints are written on every accepted replay command.  The component
# payload can contain thousands of retained bars, so storing the canonical JSON
# verbatim makes a single DISPLAY_BAR step large enough to force a SQLite WAL
# checkpoint.  Keep the logical v1 envelope unchanged and wrap only its wire
# bytes.  decode() continues to accept every pre-existing plain-JSON checkpoint.
CHECKPOINT_ZLIB_MAGIC = b"CSRP-ZLIB-V1\x00"
CHECKPOINT_COMPRESSION_MIN_BYTES = 32 * 1024
CHECKPOINT_MAX_RAW_BYTES = 512 * 1024 * 1024
CHECKPOINT_ZLIB_LEVEL = 1


class CheckpointError(ValueError):
    pass


def _strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CheckpointError(f"checkpoint JSON contains duplicate key {key}")
        result[key] = value
    return result


class CheckpointCodec:
    def __init__(self, *, schema_version: str = CHECKPOINT_SCHEMA_VERSION) -> None:
        if not isinstance(schema_version, str) or not schema_version:
            raise ValueError("checkpoint schema_version must be non-empty")
        self.schema_version = schema_version

    def encode(self, payload: Mapping[str, object]) -> bytes:
        if not isinstance(payload, Mapping):
            raise TypeError("checkpoint payload must be an object")
        normalized_payload = dict(payload)
        payload_bytes = canonical_json_bytes(normalized_payload)
        schema_bytes = canonical_json_bytes(self.schema_version)
        checksum_material = (
            b'{"payload":'
            + payload_bytes
            + b',"schema_version":'
            + schema_bytes
            + b"}"
        )
        checksum = f"sha256:{hashlib.sha256(checksum_material).hexdigest()}"
        encoded = (
            b'{"checksum":'
            + canonical_json_bytes(checksum)
            + b',"payload":'
            + payload_bytes
            + b',"schema_version":'
            + schema_bytes
            + b"}"
        )
        if len(encoded) > CHECKPOINT_MAX_RAW_BYTES:
            raise CheckpointError("checkpoint exceeds the raw byte budget")
        if len(encoded) < CHECKPOINT_COMPRESSION_MIN_BYTES:
            return encoded
        compressed = zlib.compress(encoded, level=CHECKPOINT_ZLIB_LEVEL)
        framed = CHECKPOINT_ZLIB_MAGIC + compressed
        return framed if len(framed) < len(encoded) else encoded

    def decode(self, encoded: bytes) -> dict[str, object]:
        if not isinstance(encoded, bytes) or not encoded:
            raise CheckpointError("checkpoint must be non-empty bytes")
        wire = self._decode_wire(encoded)
        try:
            decoded = json.loads(wire, object_pairs_hook=_strict_object)
        except CheckpointError:
            raise
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CheckpointError("checkpoint JSON is invalid") from exc
        if not isinstance(decoded, dict):
            raise CheckpointError("checkpoint envelope must be an object")
        if set(decoded) != {"schema_version", "checksum", "payload"}:
            raise CheckpointError("checkpoint envelope fields are invalid")
        if decoded["schema_version"] != self.schema_version:
            raise CheckpointError(
                f"checkpoint schema is incompatible: {decoded['schema_version']}"
            )
        if canonical_json_bytes(decoded) != wire:
            raise CheckpointError("checkpoint wire encoding is not canonical")
        payload = decoded["payload"]
        if not isinstance(payload, dict):
            raise CheckpointError("checkpoint payload must be an object")
        expected_checksum = canonical_sha256(
            {
                "schema_version": self.schema_version,
                "payload": payload,
            }
        )
        if decoded["checksum"] != expected_checksum:
            raise CheckpointError("checkpoint checksum mismatch")
        return payload

    @staticmethod
    def _decode_wire(encoded: bytes) -> bytes:
        if not encoded.startswith(CHECKPOINT_ZLIB_MAGIC):
            if len(encoded) > CHECKPOINT_MAX_RAW_BYTES:
                raise CheckpointError("checkpoint exceeds the raw byte budget")
            return encoded
        compressed = encoded[len(CHECKPOINT_ZLIB_MAGIC) :]
        if not compressed:
            raise CheckpointError("compressed checkpoint is empty")
        try:
            decoder = zlib.decompressobj()
            output = bytearray()
            pending = compressed
            while pending:
                remaining = CHECKPOINT_MAX_RAW_BYTES + 1 - len(output)
                if remaining <= 0:
                    raise CheckpointError("checkpoint exceeds the raw byte budget")
                output.extend(decoder.decompress(pending, remaining))
                pending = decoder.unconsumed_tail
                if not pending:
                    break
            remaining = CHECKPOINT_MAX_RAW_BYTES + 1 - len(output)
            if remaining <= 0:
                raise CheckpointError("checkpoint exceeds the raw byte budget")
            output.extend(decoder.flush(remaining))
        except zlib.error as exc:
            raise CheckpointError("compressed checkpoint is invalid") from exc
        if (
            not decoder.eof
            or decoder.unused_data
            or decoder.unconsumed_tail
            or len(output) > CHECKPOINT_MAX_RAW_BYTES
        ):
            raise CheckpointError("compressed checkpoint is invalid")
        return bytes(output)


@dataclass(frozen=True, slots=True)
class CheckpointRecord:
    encoded: bytes
    virtual_time_ms: int
    source_sequence: int
    state_hash: str
    initial: bool


@dataclass(frozen=True, slots=True)
class SelectedCheckpoint:
    record: CheckpointRecord
    payload: dict[str, object]


class CheckpointRing:
    """Keep the initial checkpoint plus a fixed number of recent candidates."""

    def __init__(self, *, max_recent: int = 32) -> None:
        if isinstance(max_recent, bool) or not isinstance(max_recent, int) or max_recent < 1:
            raise ValueError("max_recent must be a positive integer")
        self._max_recent = max_recent
        self._initial: CheckpointRecord | None = None
        self._recent: deque[CheckpointRecord] = deque(maxlen=max_recent)
        self._metrics = {
            "added": 0,
            "recent_evictions": 0,
            "corrupt_fallbacks": 0,
            "mismatch_fallbacks": 0,
            "selection_failures": 0,
        }

    def add(
        self,
        encoded: bytes,
        *,
        virtual_time_ms: int,
        source_sequence: int,
        state_hash: str,
        initial: bool = False,
    ) -> CheckpointRecord:
        if not isinstance(encoded, bytes) or not encoded:
            raise ValueError("checkpoint encoded payload must be non-empty bytes")
        record = CheckpointRecord(
            encoded=bytes(encoded),
            virtual_time_ms=validate_timestamp_ms(
                virtual_time_ms,
                field_name="virtual_time_ms",
            ),
            source_sequence=validate_counter(
                source_sequence,
                field_name="source_sequence",
            ),
            state_hash=state_hash,
            initial=bool(initial),
        )
        if initial:
            if self._initial is not None:
                raise ValueError("initial checkpoint is already present")
            self._initial = record
        else:
            if len(self._recent) == self._max_recent:
                self._metrics["recent_evictions"] += 1
            self._recent.append(record)
        self._metrics["added"] += 1
        return record

    def records(self) -> tuple[CheckpointRecord, ...]:
        initial = (self._initial,) if self._initial is not None else ()
        return initial + tuple(self._recent)

    def select_valid(
        self,
        codec: CheckpointCodec,
        *,
        target_virtual_time_ms: int,
        validator: Callable[[Mapping[str, object]], bool] | None = None,
    ) -> SelectedCheckpoint:
        target = validate_timestamp_ms(
            target_virtual_time_ms,
            field_name="target_virtual_time_ms",
        )
        candidates = sorted(
            (
                record
                for record in self.records()
                if record.virtual_time_ms <= target
            ),
            key=lambda record: (record.virtual_time_ms, record.source_sequence),
            reverse=True,
        )
        for record in candidates:
            try:
                payload = codec.decode(record.encoded)
            except CheckpointError:
                self._metrics["corrupt_fallbacks"] += 1
                continue
            if validator is not None:
                try:
                    matches = validator(payload)
                except Exception:
                    matches = False
                if not matches:
                    self._metrics["mismatch_fallbacks"] += 1
                    continue
            return SelectedCheckpoint(record=record, payload=payload)
        self._metrics["selection_failures"] += 1
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_MISMATCH,
            "no valid compatible checkpoint is available",
            details={"target_virtual_time_ms": target},
        )

    def diagnostics(self) -> dict[str, int]:
        return {
            **self._metrics,
            "records": len(self.records()),
            "max_recent": self._max_recent,
            "has_initial": int(self._initial is not None),
        }
