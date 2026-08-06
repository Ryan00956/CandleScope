"""Strict replay.v3 event envelope."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from app.replay.models import validate_identifier

from .models import (
    REPLAY_V2_PROTOCOL,
    CapabilityKind,
    CapabilityState,
    ReplayV2EventType,
    TimeDisclosurePolicy,
    TrainingCursor,
    capabilities_to_dict,
    coerce_enum,
    ensure_time_disclosure_not_weakened,
    expect_exact_keys,
    expect_mapping,
    freeze_json,
    normalize_capabilities,
    thaw_json,
    validate_v2_counter,
)


@dataclass(frozen=True, slots=True)
class ReplayV2Event:
    protocol: str
    run_id: str
    sequence: int
    revision: int
    cursor: TrainingCursor
    type: ReplayV2EventType
    time_disclosure_policy: TimeDisclosurePolicy
    capabilities: Mapping[CapabilityKind, CapabilityState]
    data: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.protocol != REPLAY_V2_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_V2_PROTOCOL}")
        object.__setattr__(
            self, "run_id", validate_identifier(self.run_id, field_name="run_id")
        )
        sequence = validate_v2_counter(self.sequence, field_name="sequence")
        if sequence == 0:
            raise ValueError("sequence must be positive")
        object.__setattr__(self, "sequence", sequence)
        object.__setattr__(
            self,
            "revision",
            validate_v2_counter(self.revision, field_name="revision"),
        )
        if not isinstance(self.cursor, TrainingCursor):
            raise TypeError("cursor must be TrainingCursor")
        if self.cursor.revision != self.revision:
            raise ValueError("cursor.revision must equal event revision")
        object.__setattr__(
            self,
            "type",
            coerce_enum(ReplayV2EventType, self.type, field_name="event type"),
        )
        object.__setattr__(
            self,
            "time_disclosure_policy",
            coerce_enum(
                TimeDisclosurePolicy,
                self.time_disclosure_policy,
                field_name="time_disclosure_policy",
            ),
        )
        object.__setattr__(
            self, "capabilities", normalize_capabilities(self.capabilities)
        )
        data = expect_mapping(self.data, field_name="data")
        object.__setattr__(self, "data", freeze_json(data, field_name="data"))

    @classmethod
    def from_dict(
        cls,
        value: object,
        authoritative_time_disclosure_policy: TimeDisclosurePolicy | str | None = None,
    ) -> "ReplayV2Event":
        payload = expect_mapping(value, field_name="event")
        expect_exact_keys(
            payload,
            {
                "protocol",
                "run_id",
                "sequence",
                "revision",
                "cursor",
                "type",
                "time_disclosure_policy",
                "capabilities",
                "data",
            },
        )
        event = cls(
            protocol=payload["protocol"],  # type: ignore[arg-type]
            run_id=payload["run_id"],  # type: ignore[arg-type]
            sequence=payload["sequence"],  # type: ignore[arg-type]
            revision=payload["revision"],  # type: ignore[arg-type]
            cursor=TrainingCursor.from_dict(payload["cursor"]),
            type=payload["type"],  # type: ignore[arg-type]
            time_disclosure_policy=payload["time_disclosure_policy"],  # type: ignore[arg-type]
            capabilities=normalize_capabilities(payload["capabilities"]),
            data=expect_mapping(payload["data"], field_name="data"),
        )
        if authoritative_time_disclosure_policy is not None:
            ensure_time_disclosure_not_weakened(
                authoritative_time_disclosure_policy,
                event.time_disclosure_policy,
            )
        return event

    def to_dict(self) -> dict[str, object]:
        return {
            "protocol": self.protocol,
            "run_id": self.run_id,
            "sequence": self.sequence,
            "revision": self.revision,
            "cursor": self.cursor.to_dict(),
            "type": self.type.value,
            "time_disclosure_policy": self.time_disclosure_policy.value,
            "capabilities": capabilities_to_dict(self.capabilities),
            "data": thaw_json(self.data),
        }


__all__ = ["ReplayV2Event"]
