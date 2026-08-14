from __future__ import annotations

from pathlib import Path

import pytest

from app.backtest.reports import build_report
from app.backtest.strategy.artifacts import ArtifactRegistry, FeatureSchema, ModelArtifact, sha256_bytes
from app.backtest.strategy.protocol import StrategyProviderError
from app.backtest.strategy.python_sidecar import PythonSidecarProvider, assert_wheel_is_offline
from app.core.config import load_backtest_settings


SCHEMA = FeatureSchema(version="feat/1", names=("close",))


def test_sidecar_cannot_import_os_or_open_files(tmp_path: Path) -> None:
    with pytest.raises(StrategyProviderError, match="cannot import"):
        assert_wheel_is_offline("import os\n")
    source = "def predict(close):\n    return open('secret.txt').read()\n"
    payload = source.encode()
    artifact = ModelArtifact(
        model_artifact_id="wheel-sec",
        format="PYTHON_WHEEL",
        artifact_hash=sha256_bytes(payload),
        feature_schema=SCHEMA,
        max_visible_time_ms=10_000,
        reproducibility_class="DETERMINISTIC",
    )
    registry = ArtifactRegistry()
    registry.register(artifact, payload)
    provider = PythonSidecarProvider(registry, "wheel-sec", source_dir=tmp_path)
    with pytest.raises(StrategyProviderError, match="approved pure functions"):
        provider.prepare({})

    escape = """def predict(close):
    return (1).__class__.__base__.__subclasses__()
"""
    payload = escape.encode()
    artifact = ModelArtifact(
        model_artifact_id="wheel-escape",
        format="PYTHON_WHEEL",
        artifact_hash=sha256_bytes(payload),
        feature_schema=SCHEMA,
        max_visible_time_ms=10_000,
        reproducibility_class="DETERMINISTIC",
    )
    registry = ArtifactRegistry()
    registry.register(artifact, payload)
    provider = PythonSidecarProvider(registry, "wheel-escape", source_dir=tmp_path)
    with pytest.raises(StrategyProviderError, match="approved pure functions|Attribute"):
        provider.prepare({})


def test_sidecar_rejects_resource_amplification(tmp_path: Path) -> None:
    source = "def predict(close):\n    return 10 ** 100000000\n"
    payload = source.encode()
    artifact = ModelArtifact(
        model_artifact_id="wheel-resource",
        format="PYTHON_WHEEL",
        artifact_hash=sha256_bytes(payload),
        feature_schema=SCHEMA,
        max_visible_time_ms=10_000,
        reproducibility_class="DETERMINISTIC",
    )
    registry = ArtifactRegistry()
    registry.register(artifact, payload)
    provider = PythonSidecarProvider(registry, "wheel-resource", source_dir=tmp_path)
    with pytest.raises(StrategyProviderError, match="Pow"):
        provider.prepare({})


def test_report_does_not_embed_env_secrets(monkeypatch) -> None:
    monkeypatch.setenv("EXCHANGE_API_KEY", "super-secret-token")
    report = build_report(
        {
            "run_id": "bt",
            "fidelity_mode": "BAR_APPROX",
            "source_event_kind": "BAR",
        }
    )
    assert "super-secret-token" not in str(report)


def test_backtest_db_stays_isolated_from_kline_and_replay(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="BACKTEST_DB_PATH"):
        load_backtest_settings(
            {"BACKTEST_DB_PATH": str(tmp_path / "candlescope.db")},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )
