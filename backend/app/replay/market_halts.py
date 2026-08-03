"""Pinned exchange-halt evidence used by BAR replay.

Raw archive gaps remain data errors by default. A gap may be crossed only when
its exact boundary matches a reviewed exchange-wide halt in this registry. The
matched payload is persisted in the replay manifest so forks and recovery use
the same decision instead of reclassifying mutable history.

Maintenance announcements establish *why* trading was unavailable. Exact gap
boundaries are independently re-checkable through the exchange's live official
Kline API; the pinned catalog revision plus exact gap match freezes the replay
decision. Estimated announcement windows are never stretched to cover gaps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from .catalog import GapRange, ReplaySeriesIdentity


REPLAY_BAR_HALT_SCHEMA_VERSION = "replay-bar-halt.v2"
BINANCE_KLINE_BOUNDARY_SOURCE = "binance_spot_klines_bracketed_gap.v1"

MAINTENANCE_NOTICE = "maintenance_notice"
MAINTENANCE_UPDATE = "maintenance_update"
MAINTENANCE_COMPLETION = "maintenance_completion"
OFFICIAL_KLINES_BOUNDARY = "official_klines_boundary"

_HALT_EVIDENCE_ROLES = frozenset(
    {
        MAINTENANCE_NOTICE,
        MAINTENANCE_UPDATE,
        MAINTENANCE_COMPLETION,
        OFFICIAL_KLINES_BOUNDARY,
    }
)
_MAINTENANCE_EVIDENCE_ROLES = frozenset(
    {MAINTENANCE_NOTICE, MAINTENANCE_UPDATE, MAINTENANCE_COMPLETION}
)


@dataclass(frozen=True, order=True, slots=True)
class ReplayBarHaltEvidence:
    """One role-labelled source reference supporting a verified BAR halt."""

    role: str
    url: str

    def __post_init__(self) -> None:
        if self.role not in _HALT_EVIDENCE_ROLES:
            raise ValueError("halt evidence role is unsupported")
        if not isinstance(self.url, str) or not self.url.strip():
            raise ValueError("halt evidence URL must be a non-empty string")
        if not self.url.startswith("https://"):
            raise ValueError("halt evidence URL must use HTTPS")

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "url": self.url}

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayBarHaltEvidence":
        if not isinstance(payload, Mapping) or set(payload) != {"role", "url"}:
            raise ValueError(
                "verified BAR halt evidence fields do not match the schema"
            )
        return cls(
            role=_strict_string(payload["role"], "role"),
            url=_strict_string(payload["url"], "url"),
        )


@dataclass(frozen=True, order=True, slots=True)
class ReplayBarHalt:
    """An inclusive range of base-bar opens where the market was unavailable."""

    start_open_ms: int
    end_open_ms: int
    halt_id: str
    resume_ms: int
    reason: str
    boundary_source: str
    evidence: tuple[ReplayBarHaltEvidence, ...]

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
            ("boundary_source", self.boundary_source),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")
        _validate_evidence_bundle(self.evidence)

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": REPLAY_BAR_HALT_SCHEMA_VERSION,
            "halt_id": self.halt_id,
            "start_open_ms": self.start_open_ms,
            "end_open_ms": self.end_open_ms,
            "resume_ms": self.resume_ms,
            "reason": self.reason,
            "boundary_source": self.boundary_source,
            "evidence": [item.to_dict() for item in self.evidence],
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
            "boundary_source",
            "evidence",
        }
        if not isinstance(payload, Mapping) or set(payload) != expected:
            raise ValueError("verified BAR halt fields do not match the schema")
        if payload["schema_version"] != REPLAY_BAR_HALT_SCHEMA_VERSION:
            raise ValueError("verified BAR halt schema is incompatible")
        raw_evidence = payload["evidence"]
        if not isinstance(raw_evidence, list):
            raise TypeError("verified BAR halt evidence must be a list")
        evidence = tuple(
            ReplayBarHaltEvidence.from_dict(item)
            if isinstance(item, Mapping)
            else _raise_evidence_type_error()
            for item in raw_evidence
        )
        return cls(
            start_open_ms=_strict_int(payload["start_open_ms"], "start_open_ms"),
            end_open_ms=_strict_int(payload["end_open_ms"], "end_open_ms"),
            halt_id=_strict_string(payload["halt_id"], "halt_id"),
            resume_ms=_strict_int(payload["resume_ms"], "resume_ms"),
            reason=_strict_string(payload["reason"], "reason"),
            boundary_source=_strict_string(
                payload["boundary_source"], "boundary_source"
            ),
            evidence=evidence,
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
            boundary_source=self.boundary_source,
            evidence=self.evidence,
        )


@dataclass(frozen=True, slots=True)
class VerifiedMarketHaltNotice:
    """Reviewed real-time interval independent of the selected BAR interval."""

    halt_id: str
    exchange: str
    market_type: str
    symbol: str
    start_ms: int
    resume_ms: int
    reason: str
    boundary_source: str
    evidence: tuple[ReplayBarHaltEvidence, ...]

    def __post_init__(self) -> None:
        for field_name, value in (
            ("start_ms", self.start_ms),
            ("resume_ms", self.resume_ms),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{field_name} must be an integer")
            if value < 0:
                raise ValueError(f"{field_name} cannot be negative")
        if self.resume_ms <= self.start_ms:
            raise ValueError("halt resume must follow its start")
        for field_name, value in (
            ("halt_id", self.halt_id),
            ("exchange", self.exchange),
            ("market_type", self.market_type),
            ("symbol", self.symbol),
            ("reason", self.reason),
            ("boundary_source", self.boundary_source),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")
        _validate_evidence_bundle(self.evidence)

    def applies_to(self, identity: ReplaySeriesIdentity) -> bool:
        return (
            identity.exchange == self.exchange
            and identity.market_type == self.market_type
            and identity.symbol == self.symbol
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
            boundary_source=self.boundary_source,
            evidence=self.evidence,
        )


def _validate_evidence_bundle(evidence: object) -> None:
    if not isinstance(evidence, tuple) or not evidence:
        raise ValueError("halt evidence must be a non-empty tuple")
    if any(not isinstance(item, ReplayBarHaltEvidence) for item in evidence):
        raise TypeError("halt evidence must contain ReplayBarHaltEvidence values")
    urls = [item.url for item in evidence]
    if len(urls) != len(set(urls)):
        raise ValueError("halt evidence URLs must be unique")
    roles = [item.role for item in evidence]
    if roles.count(OFFICIAL_KLINES_BOUNDARY) != 1:
        raise ValueError("halt evidence requires one official Kline boundary source")
    if not any(role in _MAINTENANCE_EVIDENCE_ROLES for role in roles):
        raise ValueError("halt evidence requires an official maintenance announcement")


def _binance_announcement(article_id: str) -> str:
    if article_id.isdigit():
        return f"https://www.binance.com/en/support/articles/{article_id}"
    return f"https://www.binance.com/en/support/announcement/{article_id}"


def _binance_boundary_url(start_ms: int, resume_ms: int) -> str:
    # Include the accepted minute immediately before the gap and the first
    # resumed minute. This brackets both boundaries rather than merely querying
    # an empty interior range. Every reviewed gap here is below the 1,000-row
    # public endpoint limit.
    return (
        "https://api.binance.com/api/v3/klines?"
        f"symbol=BTCUSDT&interval=1m&startTime={start_ms - 60_000}"
        f"&endTime={resume_ms}&limit=1000"
    )


def _binance_halt(
    *,
    halt_id: str,
    start_ms: int,
    resume_ms: int,
    reason: str,
    notice_ids: tuple[str, ...] = (),
    update_ids: tuple[str, ...] = (),
    completion_ids: tuple[str, ...] = (),
) -> VerifiedMarketHaltNotice:
    evidence = tuple(
        [
            *(
                ReplayBarHaltEvidence(MAINTENANCE_NOTICE, _binance_announcement(item))
                for item in notice_ids
            ),
            *(
                ReplayBarHaltEvidence(MAINTENANCE_UPDATE, _binance_announcement(item))
                for item in update_ids
            ),
            *(
                ReplayBarHaltEvidence(
                    MAINTENANCE_COMPLETION, _binance_announcement(item)
                )
                for item in completion_ids
            ),
            ReplayBarHaltEvidence(
                OFFICIAL_KLINES_BOUNDARY,
                _binance_boundary_url(start_ms, resume_ms),
            ),
        ]
    )
    return VerifiedMarketHaltNotice(
        halt_id=halt_id,
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        start_ms=start_ms,
        resume_ms=resume_ms,
        reason=reason,
        boundary_source=BINANCE_KLINE_BOUNDARY_SOURCE,
        evidence=evidence,
    )


# This registry intentionally begins after Binance switched to fixed one-minute
# archive bars. Eight legacy rows with an early (but same-bucket) close_time are
# real bars and must be normalized before these exact gaps are matched. The
# bounds below are the remaining exchange-wide maintenance gaps. They are
# pinned by the catalog and exact matcher, independently re-checkable with the
# live official Binance Kline query, and supported by official announcements.
DEFAULT_VERIFIED_MARKET_HALTS: tuple[VerifiedMarketHaltNotice, ...] = (
    _binance_halt(
        halt_id="binance-system-upgrade-2019-05-15",
        start_ms=1_557_889_200_000,
        resume_ms=1_557_925_200_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("360028054052",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2019-06-07",
        start_ms=1_559_942_040_000,
        resume_ms=1_559_945_700_000,
        reason="exchange_emergency_system_maintenance",
        notice_ids=("360029308091",),
        completion_ids=("360029309971",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2019-08-15",
        start_ms=1_565_834_400_000,
        resume_ms=1_565_863_200_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("360032315391",),
        completion_ids=("360032362171",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2019-11-13",
        start_ms=1_573_610_400_000,
        resume_ms=1_573_618_800_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("360036133111",),
        completion_ids=("360036184631",),
    ),
    _binance_halt(
        halt_id="binance-temporary-maintenance-2019-11-13",
        start_ms=1_573_623_000_000,
        resume_ms=1_573_623_180_000,
        reason="exchange_temporary_system_maintenance",
        notice_ids=("360036188511",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2019-11-25",
        start_ms=1_574_647_200_000,
        resume_ms=1_574_654_400_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("360036368212",),
        completion_ids=("360036374472",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2020-02-09",
        start_ms=1_581_213_600_000,
        resume_ms=1_581_217_200_000,
        reason="exchange_system_maintenance",
        notice_ids=("360039215732",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2020-02-19",
        start_ms=1_582_112_160_000,
        resume_ms=1_582_133_400_000,
        reason="exchange_emergency_system_maintenance",
        notice_ids=("360039975131",),
        completion_ids=("360039984971",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2020-03-04",
        start_ms=1_583_313_720_000,
        resume_ms=1_583_321_400_000,
        reason="exchange_emergency_system_maintenance",
        notice_ids=("360040075852",),
        completion_ids=("360040487771",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2020-04-25",
        start_ms=1_587_780_000_000,
        resume_ms=1_587_789_000_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("360042668671",),
        completion_ids=("360042769011",),
    ),
    _binance_halt(
        halt_id="binance-spot-system-upgrade-2020-06-28",
        start_ms=1_593_309_600_000,
        resume_ms=1_593_322_200_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("a9d34695cd9345c7a648a882fcd3bcc0",),
        update_ids=("508011c976584e6495a325a64a9af423",),
        completion_ids=("7d9d22ad6232459984c5ea30ea0986af",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2020-11-30",
        start_ms=1_606_716_000_000,
        resume_ms=1_606_719_600_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("f5e4c4bca0e440e8b832494faf74016e",),
        completion_ids=("6bddf9bad6164e4891f5cd00d938d73c",),
    ),
    _binance_halt(
        halt_id="binance-temporary-maintenance-2020-12-21",
        start_ms=1_608_559_740_000,
        resume_ms=1_608_573_600_000,
        reason="exchange_emergency_system_maintenance",
        notice_ids=("b05b72a7608943b186b981b4cc733e4e",),
        completion_ids=("b026ae47a3ab4335990d1c2f92aaeb29",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2020-12-25",
        start_ms=1_608_861_600_000,
        resume_ms=1_608_865_200_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("bea134b199a4473e901abe7ff06c3aed",),
        completion_ids=("38b072b7f1004812a16f9bbd53206ca7",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2021-02-11",
        start_ms=1_613_014_860_000,
        resume_ms=1_613_019_600_000,
        reason="exchange_emergency_system_maintenance",
        notice_ids=("7eee583e3d2346d5ac78682ac8ec9a48",),
        completion_ids=("aad7639a0ed9424bad585b508a61a433",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2021-03-06",
        start_ms=1_614_996_000_000,
        resume_ms=1_615_001_400_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("f02cab4e685b46da803bb0a680546d4b",),
        completion_ids=("089d56ca6d0c4d66b6e2d4ee065e2b19",),
    ),
    _binance_halt(
        halt_id="binance-system-upgrade-2021-04-20",
        start_ms=1_618_884_000_000,
        resume_ms=1_618_893_000_000,
        reason="exchange_scheduled_system_upgrade",
        notice_ids=("69e82a64b2c442b18eb1cf11934b27eb",),
        completion_ids=("1ff4855808344ad49265ea14a03b32bb",),
    ),
    _binance_halt(
        halt_id="binance-temporary-maintenance-2021-04-25",
        start_ms=1_619_323_260_000,
        resume_ms=1_619_340_300_000,
        reason="exchange_emergency_system_maintenance",
        notice_ids=("849160fe70214641baa6385619595aa1",),
        completion_ids=("8acdc6f4ce0e43c6a402475d35ce41ac",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2021-08-13",
        start_ms=1_628_820_000_000,
        resume_ms=1_628_836_200_000,
        reason="exchange_system_maintenance",
        notice_ids=("92a9a5bc0129427f8e9928c9b7b09836",),
        completion_ids=("3ef1861772a44c67acc2c9f5ec9f87e4",),
    ),
    _binance_halt(
        halt_id="binance-system-maintenance-2021-09-29",
        start_ms=1_632_898_800_000,
        resume_ms=1_632_906_000_000,
        reason="exchange_system_maintenance",
        notice_ids=("e2f674fc961d48af9b28edd82896607c",),
        completion_ids=("f72eb94584fa47a586127ff5149ef83c",),
    ),
    _binance_halt(
        halt_id="binance-spot-temporary-maintenance-2023-03-24",
        start_ms=1_679_661_600_000,
        resume_ms=1_679_666_400_000,
        reason="exchange_emergency_system_maintenance",
        completion_ids=("813a31506e9f478ea8c1058b425df87a",),
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


def _raise_evidence_type_error() -> ReplayBarHaltEvidence:
    raise TypeError("verified BAR halt evidence entries must be objects")


def _strict_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    return value


def _strict_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{field_name} must be a non-empty string")
    return value
