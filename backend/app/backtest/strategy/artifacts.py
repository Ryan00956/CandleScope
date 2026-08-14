"""Immutable model artifact registry and ordered feature-schema checks."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.backtest.strategy.protocol import StrategyProviderError

ARTIFACT_FORMATS = frozenset({"ONNX", "PYTHON_WHEEL", "REMOTE_DESCRIPTOR"})
REPRO_CLASSES = frozenset({"DETERMINISTIC", "SEEDED", "RECORDED_OUTPUT_ONLY"})


@dataclass(frozen=True, slots=True)
class FeatureSchema:
    version: str
    names: tuple[str, ...]

    def ordered_values(self, features: Mapping[str, Any]) -> tuple[str, ...]:
        missing = [name for name in self.names if name not in features]
        extra = [name for name in features if name not in self.names]
        if missing or extra:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                f"feature schema mismatch missing={missing} extra={extra}",
            )
        if list(features.keys()) != list(self.names):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "feature order must match the frozen schema",
            )
        return tuple(str(features[name]) for name in self.names)


@dataclass(frozen=True, slots=True)
class ModelArtifact:
    model_artifact_id: str
    format: str
    artifact_hash: str
    feature_schema: FeatureSchema
    max_visible_time_ms: int
    reproducibility_class: str
    training_snapshots: tuple[str, ...] = ()
    seed: int | None = None
    runtime_lock: str = ""
    opset: str = ""
    allow_network: bool = False
    allowed_hosts: tuple[str, ...] = ()
    device: str = "CPU"
    recorded_outputs_hash: str | None = None
    limits: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.format not in ARTIFACT_FORMATS:
            raise StrategyProviderError("SCHEMA_UNKNOWN_FIELD", f"unknown artifact format {self.format}")
        if self.reproducibility_class not in REPRO_CLASSES:
            raise StrategyProviderError(
                "SCHEMA_UNKNOWN_FIELD",
                f"unknown reproducibility class {self.reproducibility_class}",
            )
        if self.device not in {"CPU", "GPU"}:
            raise StrategyProviderError("SCHEMA_UNKNOWN_FIELD", "device must be CPU or GPU")


def sha256_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


class ArtifactRegistry:
    def __init__(self) -> None:
        self._items: dict[str, tuple[ModelArtifact, bytes]] = {}

    def register(self, artifact: ModelArtifact, payload: bytes) -> None:
        digest = sha256_bytes(payload)
        if artifact.artifact_hash not in {digest, digest.removeprefix("sha256:")}:
            raise StrategyProviderError("DATA_SNAPSHOT_MISMATCH", "artifact hash mismatch")
        if artifact.model_artifact_id in self._items:
            raise StrategyProviderError("IDENTITY_MUTATION", "artifact id is immutable")
        self._items[artifact.model_artifact_id] = (artifact, payload)

    def get(self, model_artifact_id: str) -> tuple[ModelArtifact, bytes]:
        try:
            return self._items[model_artifact_id]
        except KeyError as exc:
            raise StrategyProviderError("SCHEMA_UNKNOWN_FIELD", "unknown artifact") from exc
