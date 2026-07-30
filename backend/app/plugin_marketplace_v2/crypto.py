"""Small, explicit Ed25519 helpers used by Phase 12 verification."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .errors import MarketplaceError


ED25519_ALGORITHM = "ed25519"
_KEY_ID = re.compile(r"^ed25519:[0-9a-f]{64}$")


def decode_base64url(value: str, *, label: str, expected_size: int) -> bytes:
    if not isinstance(value, str) or not value or "=" in value:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
            f"{label} must be unpadded base64url",
        )
    try:
        decoded = base64.urlsafe_b64decode(value + ("=" * (-len(value) % 4)))
    except (ValueError, binascii.Error) as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
            f"{label} is not valid base64url",
        ) from exc
    if (
        len(decoded) != expected_size
        or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
            f"{label} has an invalid canonical encoding",
        )
    return decoded


def encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def key_id(public_key: bytes) -> str:
    if not isinstance(public_key, bytes) or len(public_key) != 32:
        raise ValueError("Ed25519 public keys must contain exactly 32 bytes")
    return f"ed25519:{hashlib.sha256(public_key).hexdigest()}"


def validate_key_id(value: str, *, label: str) -> str:
    if not isinstance(value, str) or _KEY_ID.fullmatch(value) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_KEY_INVALID",
            f"{label} must be an Ed25519 key identity",
        )
    return value


def verify_ed25519(
    *,
    public_key: bytes,
    expected_key_id: str,
    signature: str,
    message: bytes,
    label: str,
) -> None:
    validate_key_id(expected_key_id, label=f"{label}.keyId")
    if key_id(public_key) != expected_key_id:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_KEY_MISMATCH",
            f"{label} key identity does not match its public key",
        )
    raw_signature = decode_base64url(
        signature,
        label=f"{label}.value",
        expected_size=64,
    )
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(
            raw_signature,
            message,
        )
    except (InvalidSignature, ValueError) as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
            f"{label} signature verification failed",
        ) from exc
