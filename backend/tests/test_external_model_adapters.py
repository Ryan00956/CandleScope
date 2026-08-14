from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.backtest.strategy.artifacts import (
    ArtifactRegistry,
    FeatureSchema,
    ModelArtifact,
    sha256_bytes,
)
from app.backtest.strategy.external import classify_device
from app.backtest.strategy.grpc_adapter import GrpcStrategyProvider
from app.backtest.strategy.onnx_adapter import OnnxStrategyProvider
from app.backtest.strategy.protocol import (
    ObservationFrame,
    StrategyOutput,
    StrategyProviderError,
    StrategyProviderSession,
    canonical_hash,
)
from app.backtest.strategy.python_sidecar import PythonSidecarProvider, assert_wheel_is_offline
from app.backtest.strategy.pyne_adapter import PyneHostPlanner


SCHEMA = FeatureSchema(version="feat/1", names=("close",))


def _artifact(fmt: str, payload: bytes, **overrides: object) -> ModelArtifact:
    values = {
        "model_artifact_id": f"{fmt.lower()}-1",
        "format": fmt,
        "artifact_hash": sha256_bytes(payload),
        "feature_schema": SCHEMA,
        "max_visible_time_ms": 10_000,
        "reproducibility_class": "DETERMINISTIC",
        "device": "CPU",
    }
    values.update(overrides)
    return ModelArtifact(**values)  # type: ignore[arg-type]


def _frame(sequence: int, close: str, *, features: dict | None = None) -> ObservationFrame:
    feat = features if features is not None else {"close": close}
    return ObservationFrame(
        run_id="bt_ext",
        sequence=sequence,
        event_time_ms=sequence * 1000,
        watermark_ms=sequence * 1000,
        phase="EVALUATION",
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=canonical_hash(feat),
        bar={"close": close},
        features=feat,
    )


def test_feature_schema_rejects_missing_and_wrong_order() -> None:
    with pytest.raises(StrategyProviderError, match="missing"):
        SCHEMA.ordered_values({"volume": "1"})
    with pytest.raises(StrategyProviderError, match="order"):
        FeatureSchema(version="feat/1", names=("close", "volume")).ordered_values(
            {"volume": "1", "close": "2"}
        )


def test_artifact_registry_rejects_hash_mismatch() -> None:
    payload = b'{"format":"candlescope.onnx-fixture/1","threshold":100}'
    artifact = _artifact("ONNX", payload)
    registry = ArtifactRegistry()
    with pytest.raises(StrategyProviderError, match="DATA_SNAPSHOT_MISMATCH"):
        registry.register(
            ModelArtifact(
                model_artifact_id="bad",
                format="ONNX",
                artifact_hash="sha256:" + "00" * 32,
                feature_schema=SCHEMA,
                max_visible_time_ms=1,
                reproducibility_class="DETERMINISTIC",
            ),
            payload,
        )
    registry.register(artifact, payload)
    with pytest.raises(StrategyProviderError, match="IDENTITY_MUTATION"):
        registry.register(artifact, payload)


def test_onnx_fixture_end_to_end_and_host_still_plans() -> None:
    payload = json.dumps({"format": "candlescope.onnx-fixture/1", "feature": "close", "threshold": 100}).encode()
    artifact = _artifact("ONNX", payload)
    registry = ArtifactRegistry()
    registry.register(artifact, payload)
    session = StrategyProviderSession(OnnxStrategyProvider(registry, artifact.model_artifact_id), run_id="bt_ext")
    session.prepare({"inputPlan": {"roles": ["BARS"]}})
    output = session.step(_frame(1, "101"))
    assert output is not None
    assert output.kind == "SIGNAL"
    assert output.payload["direction"] == "LONG"
    planner = PyneHostPlanner()
    intents = planner.plan(output)
    assert intents[0]["side"] == "BUY"
    assert session.provider.identity()["reproducibility_class"] == "DETERMINISTIC"


def test_gpu_deterministic_request_downgrades_to_recorded_outputs() -> None:
    payload = json.dumps({"recordedOutputs": {"1": "1.5"}}).encode()
    artifact = _artifact(
        "ONNX",
        payload,
        model_artifact_id="onnx-gpu",
        device="GPU",
        reproducibility_class="DETERMINISTIC",
    )
    assert classify_device(artifact) == "RECORDED_OUTPUT_ONLY"
    registry = ArtifactRegistry()
    registry.register(artifact, payload)
    provider = OnnxStrategyProvider(registry, "onnx-gpu")
    provider.prepare({})
    output = provider.step(_frame(1, "101"))
    assert output is not None
    assert output.payload["score"] == "1.5"
    with pytest.raises(StrategyProviderError, match="recorded"):
        provider.step(_frame(2, "102"))


def test_python_sidecar_rejects_network_and_runs_offline(tmp_path: Path) -> None:
    with pytest.raises(StrategyProviderError, match="cannot import"):
        assert_wheel_is_offline("import socket\n")
    with pytest.raises(StrategyProviderError, match="cannot import"):
        assert_wheel_is_offline("from http.client import HTTPSConnection\n")
    source = "def predict(close):\n    return close - 50\n"
    payload = source.encode()
    artifact = _artifact("PYTHON_WHEEL", payload, model_artifact_id="wheel-1")
    registry = ArtifactRegistry()
    registry.register(artifact, payload)
    provider = PythonSidecarProvider(registry, "wheel-1", source_dir=tmp_path)
    session = StrategyProviderSession(provider, run_id="bt_ext")
    session.prepare({"inputPlan": {"roles": ["BARS"]}})
    output = session.step(_frame(1, "101"))
    assert output is not None
    assert output.payload["direction"] == "LONG"
    assert output.payload["score"] == "51.0"


def test_grpc_adapter_defaults_off_and_rejects_unknown_host() -> None:
    payload = b'{"host":"models.internal"}'
    artifact = _artifact(
        "REMOTE_DESCRIPTOR",
        payload,
        model_artifact_id="remote-1",
        allow_network=True,
        allowed_hosts=("models.internal",),
        reproducibility_class="RECORDED_OUTPUT_ONLY",
    )
    closed = GrpcStrategyProvider(artifact, enabled=False)
    with pytest.raises(StrategyProviderError, match="FLAG_DISABLED"):
        closed.prepare({"host": "models.internal"})
    opened = GrpcStrategyProvider(artifact, enabled=True)
    with pytest.raises(StrategyProviderError, match="not granted"):
        opened.prepare({"host": "evil.example"})
    timed = GrpcStrategyProvider(
        artifact,
        enabled=True,
        timeout_s=0.01,
        transport=lambda body: (_ for _ in ()).throw(TimeoutError()) or {},
    )
    timed.prepare({"host": "models.internal"})

    def slow(body):
        import time

        time.sleep(0.05)
        return {"score": "1"}

    slow_provider = GrpcStrategyProvider(artifact, enabled=True, timeout_s=0.01, transport=slow)
    slow_provider.prepare({"host": "models.internal"})
    with pytest.raises(StrategyProviderError, match="PROVIDER_TIMEOUT"):
        slow_provider.step(_frame(1, "101"))

    captured = GrpcStrategyProvider(
        artifact,
        enabled=True,
        transport=lambda body: {"score": "1", "echo": body["sequence"]},
    )
    captured.prepare({"host": "models.internal"})
    captured.step(_frame(1, "101"))
    assert captured.captured == [{"score": "1", "echo": 1}]


def test_external_model_cannot_emit_order_intent() -> None:
    from app.backtest.strategy.external import assert_output_allowed
    from app.backtest.strategy.protocol import ProviderCapabilities

    with pytest.raises(StrategyProviderError, match="ORDER_INTENT"):
        assert_output_allowed(
            StrategyOutput(
                sequence=1,
                kind="ORDER_INTENT",
                payload={"side": "BUY"},
                state_hash="sha256:a",
                output_hash="sha256:b",
            ),
            ProviderCapabilities(output_modes=("SIGNAL",)),
        )
