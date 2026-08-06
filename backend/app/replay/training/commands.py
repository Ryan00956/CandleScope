"""Strict replay.v3 command envelope."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from app.replay.models import validate_identifier

from .models import (
    REPLAY_V2_PROTOCOL,
    ReplayV2CommandType,
    TrainingCursor,
    coerce_enum,
    expect_exact_keys,
    expect_mapping,
    freeze_json,
    thaw_json,
    validate_v2_counter,
)


@dataclass(frozen=True, slots=True)
class ReplayV2Command:
    protocol: str
    run_id: str
    command_id: str
    client_instance_id: str
    expected_revision: int
    expected_cursor: TrainingCursor
    type: ReplayV2CommandType
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.protocol != REPLAY_V2_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_V2_PROTOCOL}")
        for field_name in ("run_id", "command_id", "client_instance_id"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(
            self,
            "expected_revision",
            validate_v2_counter(
                self.expected_revision, field_name="expected_revision"
            ),
        )
        if not isinstance(self.expected_cursor, TrainingCursor):
            raise TypeError("expected_cursor must be TrainingCursor")
        if self.expected_cursor.revision != self.expected_revision:
            raise ValueError("expected_cursor.revision must equal expected_revision")
        object.__setattr__(
            self,
            "type",
            coerce_enum(ReplayV2CommandType, self.type, field_name="command type"),
        )
        payload = expect_mapping(self.payload, field_name="payload")
        object.__setattr__(self, "payload", freeze_json(payload, field_name="payload"))

    @classmethod
    def from_dict(cls, value: object) -> "ReplayV2Command":
        payload = expect_mapping(value, field_name="command")
        expect_exact_keys(
            payload,
            {
                "protocol",
                "run_id",
                "command_id",
                "client_instance_id",
                "expected_revision",
                "expected_cursor",
                "type",
                "payload",
            },
        )
        return cls(
            protocol=payload["protocol"],  # type: ignore[arg-type]
            run_id=payload["run_id"],  # type: ignore[arg-type]
            command_id=payload["command_id"],  # type: ignore[arg-type]
            client_instance_id=payload["client_instance_id"],  # type: ignore[arg-type]
            expected_revision=payload["expected_revision"],  # type: ignore[arg-type]
            expected_cursor=TrainingCursor.from_dict(payload["expected_cursor"]),
            type=payload["type"],  # type: ignore[arg-type]
            payload=expect_mapping(payload["payload"], field_name="payload"),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "protocol": self.protocol,
            "run_id": self.run_id,
            "command_id": self.command_id,
            "client_instance_id": self.client_instance_id,
            "expected_revision": self.expected_revision,
            "expected_cursor": self.expected_cursor.to_dict(),
            "type": self.type.value,
            "payload": thaw_json(self.payload),
        }


__all__ = ["ReplayV2Command"]
