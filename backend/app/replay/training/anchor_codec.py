"""Bounded, versioned storage codec for immutable review actor anchors."""

from __future__ import annotations

import hashlib
import zlib
from dataclasses import dataclass


ANCHOR_PAYLOAD_ENCODING_RAW = "RAW"
ANCHOR_PAYLOAD_ENCODING_ZLIB_V1 = "ZLIB_V1"
ANCHOR_PAYLOAD_ENCODINGS = frozenset(
    {
        ANCHOR_PAYLOAD_ENCODING_RAW,
        ANCHOR_PAYLOAD_ENCODING_ZLIB_V1,
    }
)
MAX_ANCHOR_PAYLOAD_RAW_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class EncodedAnchorPayload:
    payload: bytes
    encoding: str
    raw_bytes: int
    stored_bytes: int
    raw_sha256: str


def _sha256(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _validated_positive_size(value: object, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{field_name} must be a positive integer")
    return value


def encode_anchor_payload(payload: bytes) -> EncodedAnchorPayload:
    if not isinstance(payload, bytes) or not payload:
        raise ValueError("review anchor payload must be non-empty bytes")
    if len(payload) > MAX_ANCHOR_PAYLOAD_RAW_BYTES:
        raise ValueError("review anchor payload exceeds the raw byte budget")
    compressed = zlib.compress(payload, level=9)
    if len(compressed) < len(payload):
        stored = compressed
        encoding = ANCHOR_PAYLOAD_ENCODING_ZLIB_V1
    else:
        stored = payload
        encoding = ANCHOR_PAYLOAD_ENCODING_RAW
    return EncodedAnchorPayload(
        payload=stored,
        encoding=encoding,
        raw_bytes=len(payload),
        stored_bytes=len(stored),
        raw_sha256=_sha256(payload),
    )


def decode_anchor_payload(
    payload: bytes,
    *,
    encoding: str,
    raw_bytes: int,
    stored_bytes: int,
    raw_sha256: str,
) -> bytes:
    if not isinstance(payload, bytes) or not payload:
        raise ValueError("review anchor stored payload must be non-empty bytes")
    if encoding not in ANCHOR_PAYLOAD_ENCODINGS:
        raise ValueError("review anchor payload encoding is unsupported")
    expected_raw_bytes = _validated_positive_size(
        raw_bytes,
        field_name="review anchor raw byte count",
    )
    if expected_raw_bytes > MAX_ANCHOR_PAYLOAD_RAW_BYTES:
        raise ValueError("review anchor payload exceeds the raw byte budget")
    expected_stored_bytes = _validated_positive_size(
        stored_bytes,
        field_name="review anchor stored byte count",
    )
    if len(payload) != expected_stored_bytes:
        raise ValueError("review anchor stored byte count does not match")
    if (
        not isinstance(raw_sha256, str)
        or len(raw_sha256) != 71
        or not raw_sha256.startswith("sha256:")
    ):
        raise ValueError("review anchor raw checksum is invalid")

    if encoding == ANCHOR_PAYLOAD_ENCODING_RAW:
        if len(payload) != expected_raw_bytes:
            raise ValueError("raw review anchor byte count does not match")
        raw = payload
    else:
        try:
            decoder = zlib.decompressobj()
            output = bytearray()
            pending = payload
            while pending:
                remaining_budget = expected_raw_bytes + 1 - len(output)
                if remaining_budget <= 0:
                    raise ValueError(
                        "review anchor payload exceeds its declared size"
                    )
                output.extend(decoder.decompress(pending, remaining_budget))
                pending = decoder.unconsumed_tail
                if not pending:
                    break
            remaining_budget = expected_raw_bytes + 1 - len(output)
            output.extend(decoder.flush(max(1, remaining_budget)))
        except zlib.error as exc:
            raise ValueError("compressed review anchor payload is invalid") from exc
        if (
            not decoder.eof
            or decoder.unused_data
            or len(output) != expected_raw_bytes
        ):
            raise ValueError("compressed review anchor payload is invalid")
        raw = bytes(output)

    if _sha256(raw) != raw_sha256:
        raise ValueError("review anchor raw checksum does not match")
    return raw


__all__ = [
    "ANCHOR_PAYLOAD_ENCODINGS",
    "ANCHOR_PAYLOAD_ENCODING_RAW",
    "ANCHOR_PAYLOAD_ENCODING_ZLIB_V1",
    "EncodedAnchorPayload",
    "MAX_ANCHOR_PAYLOAD_RAW_BYTES",
    "decode_anchor_payload",
    "encode_anchor_payload",
]
