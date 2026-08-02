"""Pinned exchange-halt evidence used by BAR replay.

Raw archive gaps remain data errors by default.  A gap may be crossed only when
its exact boundary matches a reviewed exchange-wide halt in this registry.  The
matched payload is persisted in the replay manifest so forks and recovery use
the same decision instead of reclassifying mutable history.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from .catalog import GapRange, ReplaySeriesIdentity


REPLAY_BAR_HALT_SCHEMA_VERSION = "replay-bar-halt.v1"


@dataclass(frozen=True, order=True, slots=True)
class ReplayBarHalt:
    """An inclusive range of base-bar opens where the market was unavailable."""

    start_open_ms: int
    end_open_ms: int
    halt_id: str
    resume_ms: int
    reason: str
    evidence_url: str

    def __post_init__(self) -> None:
        for field_name, value in (
            ("start_open_ms", self.start_open_ms),
            ("end_open_ms", self.end_open_ms),
            ("resume_ms", self.resume_ms),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{field_name} must be an integer")
            if value < 0:
                raise ValueError(f"{field_name} cannot be negative")
        if self.end_open_ms < self.start_open_ms:
            raise ValueError("halt end cannot precede its start")
        if self.resume_ms <= self.end_open_ms:
            raise ValueError("halt resume must follow its last excluded open")
        for field_name, value in (
            ("halt_id", self.halt_id),
            ("reason", self.reason),
            ("evidence_url", self.evidence_url),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")
        if not self.evidence_url.startswith("https://"):
            raise ValueError("halt evidence_url must use HTTPS")

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": REPLAY_BAR_HALT_SCHEMA_VERSION,
            "halt_id": self.halt_id,
            "start_open_ms": self.start_open_ms,
            "end_open_ms": self.end_open_ms,
            "resume_ms": self.resume_ms,
            "reason": self.reason,
            "evidence_url": self.evidence_url,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayBarHalt":
        expected = {
            "schema_version",
            "halt_id",
            "start_open_ms",
            "end_open_ms",
            "resume_ms",
            "reason",
            "evidence_url",
        }
        if not isinstance(payload, Mapping) or set(payload) != expected:
            raise ValueError("verified BAR halt fields do not match the schema")
        if payload["schema_version"] != REPLAY_BAR_HALT_SCHEMA_VERSION:
            raise ValueError("verified BAR halt schema is incompatible")
        return cls(
            start_open_ms=_strict_int(payload["start_open_ms"], "start_open_ms"),
            end_open_ms=_strict_int(payload["end_open_ms"], "end_open_ms"),
            halt_id=_strict_string(payload["halt_id"], "halt_id"),
            resume_ms=_strict_int(payload["resume_ms"], "resume_ms"),
            reason=_strict_string(payload["reason"], "reason"),
            evidence_url=_strict_string(payload["evidence_url"], "evidence_url"),
        )

    def shifted(self, delta_ms: int) -> "ReplayBarHalt":
        if isinstance(delta_ms, bool) or not isinstance(delta_ms, int):
            raise TypeError("delta_ms must be an integer")
        return ReplayBarHalt(
            start_open_ms=self.start_open_ms + delta_ms,
            end_open_ms=self.end_open_ms + delta_ms,
            halt_id=self.halt_id,
            resume_ms=self.resume_ms + delta_ms,
            reason=self.reason,
            evidence_url=self.evidence_url,
        )


@dataclass(frozen=True, slots=True)
class VerifiedMarketHaltNotice:
    """Reviewed real-time interval independent of the selected BAR interval."""

    halt_id: str
    exchange: str
    market_type: str
    start_ms: int
    resume_ms: int
    reason: str
    evidence_url: str

    def applies_to(self, identity: ReplaySeriesIdentity) -> bool:
        return (
            identity.exchange == self.exchange
            and identity.market_type == self.market_type
        )

    def for_interval(self, interval_ms: int) -> ReplayBarHalt | None:
        if isinstance(interval_ms, bool) or not isinstance(interval_ms, int):
            raise TypeError("interval_ms must be an integer")
        if interval_ms < 1:
            raise ValueError("interval_ms must be positive")
        duration_ms = self.resume_ms - self.start_ms
        if (
            duration_ms < interval_ms
            or duration_ms % interval_ms != 0
            or self.start_ms % interval_ms != 0
            or self.resume_ms % interval_ms != 0
        ):
            return None
        return ReplayBarHalt(
            start_open_ms=self.start_ms,
            end_open_ms=self.resume_ms - interval_ms,
            halt_id=self.halt_id,
            resume_ms=self.resume_ms,
            reason=self.reason,
            evidence_url=self.evidence_url,
        )


# Binance announced an exchange-wide system upgrade beginning at 03:00 UTC on
# 2019-05-15 and later announced that trading would resume at 13:00 UTC.  This
# exact ten-hour window matches the immutable archive gap; no fuzzy or partial
# overlap is accepted.
DEFAULT_VERIFIED_MARKET_HALTS: tuple[VerifiedMarketHaltNotice, ...] = (
    VerifiedMarketHaltNotice(
        halt_id="binance-system-upgrade-2019-05-15",
        exchange="binance",
        market_type="spot",
        start_ms=1_557_889_200_000,
        resume_ms=1_557_925_200_000,
        reason="exchange_scheduled_system_upgrade",
        evidence_url=(
            "https://binance.zendesk.com/hc/en-us/articles/"
            "360028054052-System-Upgrade-Notice"
        ),
    ),
)


def match_verified_market_halt(
    identity: ReplaySeriesIdentity,
    gap: GapRange,
    *,
    interval_ms: int,
    notices: Iterable[VerifiedMarketHaltNotice] = DEFAULT_VERIFIED_MARKET_HALTS,
) -> ReplayBarHalt | None:
    """Return an exact reviewed match; partial overlaps remain ordinary gaps."""

    if not isinstance(identity, ReplaySeriesIdentity):
        raise TypeError("identity must be ReplaySeriesIdentity")
    if not isinstance(gap, GapRange):
        raise TypeError("gap must be GapRange")
    for notice in notices:
        if not isinstance(notice, VerifiedMarketHaltNotice):
            raise TypeError("notices must contain VerifiedMarketHaltNotice values")
        if not notice.applies_to(identity):
            continue
        halt = notice.for_interval(interval_ms)
        if halt is None:
            continue
        expected_missing = ((halt.end_open_ms - halt.start_open_ms) // interval_ms) + 1
        if (
            gap.start_ms == halt.start_open_ms
            and gap.end_ms == halt.end_open_ms
            and gap.missing_bars == expected_missing
        ):
            return halt
    return None


def validate_registered_bar_halts(
    payloads: object,
    *,
    identity: ReplaySeriesIdentity,
    interval_ms: int,
    notices: Sequence[VerifiedMarketHaltNotice] = DEFAULT_VERIFIED_MARKET_HALTS,
) -> tuple[ReplayBarHalt, ...]:
    """Decode a persisted list and prove every entry is still registry-exact."""

    if not isinstance(payloads, list):
        raise TypeError("verified_market_halts must be a list")
    decoded: list[ReplayBarHalt] = []
    for raw in payloads:
        if not isinstance(raw, Mapping):
            raise TypeError("verified_market_halts entries must be objects")
        halt = ReplayBarHalt.from_dict(raw)
        match = next(
            (
                notice.for_interval(interval_ms)
                for notice in notices
                if notice.halt_id == halt.halt_id and notice.applies_to(identity)
            ),
            None,
        )
        if match is None or match != halt:
            raise ValueError("persisted BAR halt is not an exact reviewed notice")
        decoded.append(halt)
    if decoded != sorted(decoded):
        raise ValueError("verified BAR halts must be sorted")
    for previous, current in zip(decoded, decoded[1:]):
        if current.start_open_ms <= previous.end_open_ms:
            raise ValueError("verified BAR halts overlap")
    return tuple(decoded)


def _strict_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    return value


def _strict_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{field_name} must be a non-empty string")
    return value
