from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def _python() -> str:
    return sys.executable


def test_library_flags_remain_default_off() -> None:
    config = (BACKEND / "app" / "core" / "config.py").read_text(encoding="utf-8")
    flags = (
        ROOT / "frontend" / "src" / "features" / "research-data" / "researchDataFlags.ts"
    ).read_text(encoding="utf-8")
    assert (
        'RESEARCH_DATA_LIBRARY_ENABLED = _parse_strict_flag(\n    "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",\n    "0",\n)'
        in config.replace("\r\n", "\n")
    )
    assert 'return raw === true || raw === 1 || raw === "1";' in flags


def test_dual_flag_off_live_does_not_mount_library() -> None:
    script = """
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import RESEARCH_DATA_LIBRARY_ENABLED, RUNTIME_MODE
assert RUNTIME_MODE == "LIVE"
assert RESEARCH_DATA_LIBRARY_ENABLED is False
client = TestClient(app)
assert client.get("/health").status_code == 200
assert client.get("/api/v1/local/datasets").status_code == 404
"""
    environment = os.environ.copy()
    environment.update(
        {
            "CANDLESCOPE_RUNTIME_MODE": "LIVE",
            "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED": "0",
            "BACKTEST_ENABLED": "0",
            "CANDLE_DATA_DIR": str(BACKEND / "tests" / ".tmp-unification-live"),
            "CANDLESCOPE_LOCAL_DATA_DIR": str(BACKEND / "tests" / ".tmp-unification-live-local"),
        }
    )
    completed = subprocess.run(
        [_python(), "-c", script],
        cwd=BACKEND,
        env=environment,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_verifier_script_exists_and_requires_default_off_flags() -> None:
    verifier = (BACKEND / "scripts" / "verify_strategy_research_unification.py").read_text(encoding="utf-8")
    schema = json.loads(
        (ROOT / "docs" / "evidence" / "strategy-research-unification-release.schema.json").read_text(
            encoding="utf-8"
        )
    )
    assert "libraryFlagsDefaultOff" in verifier
    assert schema["properties"]["effectiveFlags"]["properties"]["CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED"]["const"] == "0"
    assert schema["properties"]["scope"]["properties"]["oldWorktreeDeleted"]["const"] is False
