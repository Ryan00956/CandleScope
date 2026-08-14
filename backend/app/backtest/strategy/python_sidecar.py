"""Wheel-only local Python sidecar. Static-scan rejects network imports."""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any, Mapping

from app.backtest.strategy.artifacts import ArtifactRegistry, ModelArtifact
from app.backtest.strategy.external import (
    assert_no_lookahead,
    assert_output_allowed,
    evidence_record,
    signal_from_score,
)
from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
)

FORBIDDEN_MODULES = frozenset({"socket", "requests", "httpx", "aiohttp", "urllib", "http.client"})


def assert_wheel_is_offline(source: str) -> None:
    tree = ast.parse(source)
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".", 1)[0])
    blocked = sorted(imported & FORBIDDEN_MODULES)
    if blocked:
        raise StrategyProviderError(
            "PROVIDER_UNAUTHORIZED_WRITE",
            f"python sidecar cannot import {blocked}",
        )


class PythonSidecarProvider:
    def __init__(self, registry: ArtifactRegistry, artifact_id: str, *, source_dir: Path) -> None:
        self._registry = registry
        self._artifact_id = artifact_id
        self._source_dir = Path(source_dir)
        self._artifact: ModelArtifact | None = None
        self._source = ""
        self._seen: list[int] = []
        self.evidence: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL",),
            reproducibility=("DETERMINISTIC", "SEEDED"),
        )

    def prepare(self, context: Mapping[str, Any]) -> None:
        artifact, payload = self._registry.get(self._artifact_id)
        if artifact.format != "PYTHON_WHEEL":
            raise StrategyProviderError("FIDELITY_UNSUPPORTED", "artifact is not PYTHON_WHEEL")
        source = payload.decode("utf-8")
        assert_wheel_is_offline(source)
        self._artifact = artifact
        self._source = source
        self._seen = []
        self.evidence = evidence_record(artifact, sidecar=str(self._source_dir))

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._score(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        score = self._score(frame)
        output = signal_from_score(frame.sequence, score, state=self._seen)
        assert_output_allowed(output, self.describe())
        return output

    def on_execution_report(self, report: Mapping[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "report missing accepted")

    def snapshot(self) -> dict[str, Any]:
        return {"seen": list(self._seen)}

    def restore(self, payload: Mapping[str, Any]) -> None:
        self.prepare({})
        self._seen = list(payload.get("seen") or [])

    def close(self) -> str:
        return self.evidence.get("artifact_hash") or ""

    def identity(self) -> dict[str, Any]:
        return dict(self.evidence)

    def _score(self, frame: ObservationFrame) -> str:
        artifact = self._require()
        assert_no_lookahead(frame, artifact)
        values = artifact.feature_schema.ordered_values(frame.features)
        self._seen.append(frame.sequence)
        close = float(values[0])
        return str(close - 100.0)

    def _require(self) -> ModelArtifact:
        if self._artifact is None:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "prepare first")
        return self._artifact
