"""Authoritative K-line source quality and finality policy.

The SQLite schema intentionally keeps provenance in the existing ``source``
column.  This module is therefore the single policy surface used by Python
merges and by the generated SQLite ``CASE`` expression.  Keeping both paths
derived from the same mapping prevents cache/storage precedence drift.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping


class FinalityTrust(str, Enum):
    """How much finality authority a source carries."""

    UNTRUSTED = "untrusted"
    AMBIGUOUS = "ambiguous"
    TRUSTED_FINAL = "trusted_final"


@dataclass(frozen=True, slots=True)
class SourceQuality:
    rank: int
    finality: FinalityTrust

    @property
    def trusted_final(self) -> bool:
        return self.finality is FinalityTrust.TRUSTED_FINAL


# Higher ranks may replace lower ranks at the same open_time.  Equal ranks are
# deliberately replaceable so a later revision from the same authority can
# amend values without requiring another schema column.
SOURCE_QUALITY: dict[str, SourceQuality] = {
    # Legacy timeout/teardown CLOSED rows did not prove an exchange close.
    "data_manager_closed": SourceQuality(10, FinalityTrust.AMBIGUOUS),
    # Explicit exchange close (for example Binance kline x=true).
    "data_manager_exchange_closed": SourceQuality(50, FinalityTrust.TRUSTED_FINAL),
    # Realtime custom bars whose complete component set carried final closes.
    "data_manager_composite_closed": SourceQuality(60, FinalityTrust.TRUSTED_FINAL),
    # Custom bars rebuilt from already-final component bars.
    "backfill_aggregated": SourceQuality(60, FinalityTrust.TRUSTED_FINAL),
    # Direct provider history.
    "backfill": SourceQuality(70, FinalityTrust.TRUSTED_FINAL),
    # Official closed-period archive rows carry the same semantic authority as
    # provider REST. Checksums prove transfer integrity, not higher market-data
    # authority, so explicit REST verification remains able to supersede them.
    "backfill_archive_verified": SourceQuality(70, FinalityTrust.TRUSTED_FINAL),
    "backfill_archive_confirmed": SourceQuality(70, FinalityTrust.TRUSTED_FINAL),
    # An explicit amendment is authoritative over the original close.
    "data_manager_amended": SourceQuality(80, FinalityTrust.TRUSTED_FINAL),
    # Reserved names for exact REST verification and repair lanes.
    "backfill_rest_verified": SourceQuality(90, FinalityTrust.TRUSTED_FINAL),
    "repair_binance_rest_verified": SourceQuality(100, FinalityTrust.TRUSTED_FINAL),
    "repair_derived_verified": SourceQuality(100, FinalityTrust.TRUSTED_FINAL),
    # The legacy settings repair checked continuity but not component provenance.
    "settings_manual_repair": SourceQuality(10, FinalityTrust.AMBIGUOUS),
}

UNKNOWN_SOURCE_QUALITY = SourceQuality(0, FinalityTrust.UNTRUSTED)

# Repair requests emitted for rows that exist physically but do not carry an
# authoritative close must not be handled like ordinary timestamp gaps.  Keep
# this semantic policy beside the source-quality table so detection, repair,
# and verification cannot drift apart again.
TRUSTED_FINALITY_REPAIR_REASONS = frozenset({"query_untrusted_finality"})


def normalize_kline_source(source: object) -> str:
    """Return the canonical storage/cache source identifier."""

    return str(source or "").strip().lower()


def kline_source_quality(source: object) -> SourceQuality:
    """Resolve source quality, failing closed for absent/unknown sources."""

    return SOURCE_QUALITY.get(normalize_kline_source(source), UNKNOWN_SOURCE_QUALITY)


def source_rank(source: object) -> int:
    return kline_source_quality(source).rank


def source_is_trusted_final(source: object) -> bool:
    return kline_source_quality(source).trusted_final


def repair_requires_trusted_finality(
    metadata: Mapping[str, Any] | None = None,
    *,
    reason: object = None,
) -> bool:
    """Return whether a repair must replace rows with trusted-final data.

    ``requires_trusted_finality`` is the durable, merge-safe contract.  The
    reason fields remain recognized so queued ledger rows created before that
    flag existed are repaired correctly after an upgrade.
    """

    details = metadata or {}
    if details.get("requires_trusted_finality") is True:
        return True

    candidates: list[object] = [
        reason,
        details.get("reason"),
        details.get("query_reason"),
    ]
    query_reasons = details.get("query_reasons")
    if isinstance(query_reasons, (list, tuple, set, frozenset)):
        candidates.extend(query_reasons)

    return any(
        part.strip() in TRUSTED_FINALITY_REPAIR_REASONS
        for candidate in candidates
        for part in str(candidate or "").split("+")
    )


def incoming_source_can_replace(existing_source: object, incoming_source: object) -> bool:
    """Return whether incoming provenance may replace an existing row/bar."""

    return source_rank(incoming_source) >= source_rank(existing_source)


def source_rank_sql(expression: str) -> str:
    """Generate SQLite rank SQL from :data:`SOURCE_QUALITY`.

    ``expression`` is supplied by repository code, never user input.  Source
    names are policy constants and are escaped defensively for SQL literals.
    """

    clauses = " ".join(
        f"WHEN '{source.replace(chr(39), chr(39) * 2)}' THEN {quality.rank}"
        for source, quality in SOURCE_QUALITY.items()
    )
    return f"CASE lower(trim(COALESCE({expression}, ''))) {clauses} ELSE 0 END"
