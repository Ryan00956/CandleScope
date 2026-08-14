"""ONNX-class strategy adapter. No network. GPU determinism is fail-closed."""

from __future__ import annotations

import json
from typing import Any, Mapping

from app.backtest.strategy.artifacts import ArtifactRegistry, ModelArtifact
from app.backtest.strategy.external import (
    assert_no_lookahead,
    assert_output_allowed,
    classify_device,
    evidence_record,
    signal_from_score,
)
from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
)


class OnnxStrategyProvider:
    def __init__(self, registry: ArtifactRegistry, artifact_id: str) -> None:
        self._registry = registry
        self._artifact_id = artifact_id
        self._artifact: ModelArtifact | None = None
        self._payload = b""
        self._seen: list[int] = []
        self.evidence: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL",),
            reproducibility=("DETERMINISTIC", "SEEDED", "RECORDED_OUTPUT_ONLY"),
        )

    def prepare(self, context: Mapping[str, Any]) -> None:
        artifact, payload = self._registry.get(self._artifact_id)
        if artifact.format != "ONNX":
            raise StrategyProviderError("FIDELITY_UNSUPPORTED", "artifact is not ONNX")
        self._artifact = artifact
        self._payload = payload
        self._seen = []
        self.evidence = evidence_record(artifact, backend=self._backend_name())

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._infer(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        score = self._infer(frame)
        output = signal_from_score(frame.sequence, score, state=self._seen)
        assert_output_allowed(output, self.describe())
        return output

    def on_execution_report(self, report: Mapping[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "report missing accepted")

    def snapshot(self) -> dict[str, Any]:
        return {"seen": list(self._seen), "artifactId": self._artifact_id}

    def restore(self, payload: Mapping[str, Any]) -> None:
        self.prepare({})
        self._seen = list(payload.get("seen") or [])

    def close(self) -> str:
        return self.evidence.get("artifact_hash") or ""

    def identity(self) -> dict[str, Any]:
        return dict(self.evidence)

    def _infer(self, frame: ObservationFrame) -> str:
        artifact = self._require()
        assert_no_lookahead(frame, artifact)
        values = artifact.feature_schema.ordered_values(frame.features)
        self._seen.append(frame.sequence)
        if classify_device(artifact) == "RECORDED_OUTPUT_ONLY":
            recorded = json.loads(self._payload.decode("utf-8"))
            outputs = recorded.get("recordedOutputs") or {}
            if str(frame.sequence) not in outputs:
                raise StrategyProviderError(
                    "PROVIDER_CRASH_UNRECOVERABLE",
                    "GPU/non-deterministic ONNX requires recorded outputs",
                )
            return str(outputs[str(frame.sequence)])
        spec = json.loads(self._payload.decode("utf-8"))
        if spec.get("format") != "candlescope.onnx-fixture/1":
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "live ONNX runtime is not installed; use a fixture or recorded outputs",
            )
        feature = spec.get("feature") or artifact.feature_schema.names[0]
        threshold = float(spec.get("threshold") or 0)
        score = float(frame.features[feature]) - threshold
        return str(score)

    def _backend_name(self) -> str:
        artifact = self._require()
        return "recorded" if classify_device(artifact) == "RECORDED_OUTPUT_ONLY" else "onnx-fixture"

    def _require(self) -> ModelArtifact:
        if self._artifact is None:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "prepare first")
        return self._artifact
