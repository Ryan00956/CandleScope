"""Shared Host-side guards for non-script strategy providers."""

from __future__ import annotations

from typing import Any

from app.backtest.strategy.artifacts import ModelArtifact
from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
    canonical_hash,
)


def assert_no_lookahead(frame: ObservationFrame, artifact: ModelArtifact) -> None:
    if frame.event_time_ms > frame.watermark_ms:
        raise StrategyProviderError("LOOKAHEAD_VIOLATION", "feature after watermark")
    if frame.event_time_ms > artifact.max_visible_time_ms:
        raise StrategyProviderError("LOOKAHEAD_VIOLATION", "feature after training horizon")


def assert_output_allowed(output: StrategyOutput, capabilities: ProviderCapabilities) -> None:
    if output.kind not in capabilities.output_modes:
        raise StrategyProviderError(
            "PROVIDER_UNAUTHORIZED_WRITE",
            f"{output.kind} is not declared by this provider",
        )
    if output.kind == "ORDER_INTENT":
        raise StrategyProviderError(
            "PROVIDER_UNAUTHORIZED_WRITE",
            "external models may not emit ORDER_INTENT",
        )


def classify_device(artifact: ModelArtifact) -> str:
    if artifact.device == "GPU" and artifact.reproducibility_class == "DETERMINISTIC":
        return "RECORDED_OUTPUT_ONLY"
    return artifact.reproducibility_class


def signal_from_score(sequence: int, score: str, *, state: object) -> StrategyOutput:
    direction = "LONG" if float(score) > 0 else "FLAT"
    payload = {"direction": direction, "score": str(score), "reasonCode": "model_score"}
    return StrategyOutput(
        sequence=sequence,
        kind="SIGNAL",
        payload=payload,
        state_hash=canonical_hash(state),
        output_hash=canonical_hash({"sequence": sequence, "payload": payload}),
    )


def evidence_record(artifact: ModelArtifact, **extra: Any) -> dict[str, Any]:
    return {
        "model_artifact_id": artifact.model_artifact_id,
        "format": artifact.format,
        "artifact_hash": artifact.artifact_hash,
        "reproducibility_class": classify_device(artifact),
        "device": artifact.device,
        "runtime_lock": artifact.runtime_lock,
        "network": artifact.allow_network,
        **extra,
    }
