"""Product-facing support metadata for registered exchange plugins.

Exchange capabilities describe what one adapter can route. This module keeps
orthogonal implementation and qualification facts separate so callers do not
turn CCXT catalog presence into a blanket production-readiness claim.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .products import serialize_product_support


@dataclass(frozen=True, slots=True)
class ExchangeQualification:
    ccxt_version: str
    level: str
    verified_at: str
    market_types: tuple[str, ...]
    channels: tuple[str, ...]
    evidence_id: str
    duration_seconds: int | None = None
    event_count: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ccxt_version": self.ccxt_version,
            "level": self.level,
            "verified_at": self.verified_at,
            "market_types": list(self.market_types),
            "channels": list(self.channels),
            "evidence_id": self.evidence_id,
            "duration_seconds": self.duration_seconds,
            "event_count": self.event_count,
        }


_QUALIFICATION_MANIFEST = Path(__file__).with_name("qualification_manifest.json")


@lru_cache(maxsize=1)
def load_qualification_manifest() -> dict[str, Any]:
    """Load and validate retained qualification evidence fail-closed."""

    raw = json.loads(_QUALIFICATION_MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise ValueError("unsupported exchange qualification manifest schema")
    version = str(raw.get("ccxt_version") or "").strip()
    records = raw.get("records")
    if not version or not isinstance(records, list):
        raise ValueError("exchange qualification manifest is incomplete")
    evidence_ids: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise TypeError("exchange qualification records must be objects")
        required = {
            "exchange",
            "level",
            "verified_at",
            "market_types",
            "channels",
            "evidence_id",
        }
        if not required.issubset(record):
            raise ValueError("exchange qualification record is incomplete")
        if record["level"] not in {"shadow", "soak"}:
            raise ValueError("exchange qualification level must be shadow or soak")
        evidence_id = str(record["evidence_id"]).strip()
        if not evidence_id or evidence_id in evidence_ids:
            raise ValueError("exchange qualification evidence IDs must be unique")
        evidence_ids.add(evidence_id)
    return raw


@lru_cache(maxsize=1)
def _ccxt_qualifications() -> dict[str, tuple[ExchangeQualification, ...]]:
    manifest = load_qualification_manifest()
    version = str(manifest["ccxt_version"])
    grouped: dict[str, list[ExchangeQualification]] = {}
    for raw in manifest["records"]:
        exchange = str(raw["exchange"]).strip().lower()
        grouped.setdefault(exchange, []).append(ExchangeQualification(
            ccxt_version=version,
            level=str(raw["level"]),
            verified_at=str(raw["verified_at"]),
            market_types=tuple(str(value) for value in raw["market_types"]),
            channels=tuple(str(value) for value in raw["channels"]),
            evidence_id=str(raw["evidence_id"]),
            duration_seconds=raw.get("duration_seconds"),
            event_count=raw.get("event_count"),
        ))
    return {key: tuple(value) for key, value in grouped.items()}


def serialize_exchange_support(plugin: Any, capabilities: Any) -> dict[str, Any]:
    """Return implementation, routing, and retained qualification metadata."""

    features = {
        str(value).strip().lower()
        for value in (getattr(capabilities, "protocol_features", ()) or ())
        if str(value).strip()
    }
    if "provider.ccxt_primary" in features:
        provider = "ccxt_primary"
    elif "provider.ccxt_unified" in features:
        provider = "ccxt_unified"
    else:
        provider = "plugin"

    markets = tuple(getattr(capabilities, "markets", ()) or ())
    channels = tuple(getattr(capabilities, "channels", ()) or ())
    schema_version = int(getattr(capabilities, "capability_schema_version", 1) or 1)
    routable = bool(markets) and (schema_version <= 1 or bool(channels))

    limits = dict(getattr(capabilities, "limits", {}) or {})
    ccxt_version_value = limits.get("ccxt.version")
    if ccxt_version_value in (None, "") and provider == "ccxt_primary":
        # Primary profiles are merged with native plugins, whose legacy limits
        # intentionally omit CCXT metadata.  The provider feature is enough to
        # bind retained evidence to the installed pinned kernel version.
        try:
            from app.exchanges.ccxt_ext.binance_usdm import SUPPORTED_CCXT_VERSION

            ccxt_version_value = SUPPORTED_CCXT_VERSION
        except ImportError:
            ccxt_version_value = None
    ccxt_version = (
        str(ccxt_version_value).strip() if ccxt_version_value not in (None, "") else None
    )
    retained = _ccxt_qualifications().get(
        str(getattr(plugin, "id", "")).lower(),
        (),
    )
    qualifications = tuple(
        item
        for item in retained
        if routable and ccxt_version == item.ccxt_version
    )
    if not qualifications:
        qualification_payload = None
        qualification_payloads: list[dict[str, Any]] = []
        verification_level = "capability_contract" if routable else "catalog_only"
    else:
        qualification_payloads = [item.to_dict() for item in qualifications]
        qualification_payload = qualification_payloads[0]
        verification_level = (
            "soak"
            if any(item.level == "soak" for item in qualifications)
            else "shadow"
        )

    return {
        "provider": provider,
        "routable": routable,
        "verification_level": verification_level,
        "qualification": qualification_payload,
        "qualifications": qualification_payloads,
        "products": serialize_product_support(capabilities),
    }
