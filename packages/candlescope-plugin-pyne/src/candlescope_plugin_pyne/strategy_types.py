"""Local strategy-provider types so the adapter does not import Host packages."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Mapping


CONTRIBUTION_KIND = "strategy-provider/1"
OUTPUT_SCHEMA = "candlescope.strategy-output/1"


class StrategyProviderError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def canonical_hash(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    input_modes: tuple[str, ...] = ("BAR_CLOSE",)
    output_modes: tuple[str, ...] = ("SIGNAL", "TARGET_POSITION")
    state_modes: tuple[str, ...] = ("SESSION_STATEFUL",)
    reproducibility: tuple[str, ...] = ("DETERMINISTIC", "SEEDED")
    snapshot_restore: bool = True
    signal_clock: str = "EVENT"
    required_features: tuple[str, ...] = ()
    warmup_requirement: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class StrategyOutput:
    sequence: int
    kind: str
    payload: Mapping[str, Any]
    state_hash: str
    output_hash: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": OUTPUT_SCHEMA,
            "sequence": self.sequence,
            "kind": self.kind,
            "payload": dict(self.payload),
            "stateHash": self.state_hash,
            "outputHash": self.output_hash,
        }
