from __future__ import annotations

import json
import runpy
import subprocess
import sys
from pathlib import Path

import pytest
from tests.source_checkout_testkit import source_checkout_environment

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def _python() -> str:
    return sys.executable


def test_library_flags_default_on_with_explicit_off_rollback() -> None:
    config = (BACKEND / "app" / "core" / "config.py").read_text(encoding="utf-8")
    flags = (
        ROOT / "frontend" / "src" / "features" / "research-data" / "researchDataFlags.ts"
    ).read_text(encoding="utf-8")
    assert (
        'RESEARCH_DATA_LIBRARY_ENABLED = _parse_strict_flag(\n    "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",\n    "1",\n)'
        in config.replace("\r\n", "\n")
    )
    assert "if (raw === undefined)" in flags
    assert 'return raw === true || raw === 1 || raw === "1";' in flags


def test_default_on_live_mounts_library_router() -> None:
    script = """
from app.main import app
from app.core.config import RESEARCH_DATA_LIBRARY_ENABLED, RUNTIME_MODE
assert RUNTIME_MODE == "LIVE"
assert RESEARCH_DATA_LIBRARY_ENABLED is True
assert any(route.path == "/api/v1/local/datasets" for route in app.routes)
"""
    environment = source_checkout_environment()
    environment.pop("CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED", None)
    environment.update(
        {
            "CANDLESCOPE_RUNTIME_MODE": "LIVE",
            "BACKTEST_ENABLED": "0",
            "CANDLE_DATA_DIR": str(BACKEND / "tests" / ".tmp-unification-live-default-on"),
            "CANDLESCOPE_LOCAL_DATA_DIR": str(
                BACKEND / "tests" / ".tmp-unification-live-default-on-local"
            ),
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
    environment = source_checkout_environment(
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


def test_verifier_accepts_only_evidence_after_a_clean_candidate(tmp_path: Path) -> None:
    verifier_path = BACKEND / "scripts" / "verify_strategy_research_unification.py"
    verify = runpy.run_path(str(verifier_path))["verify"]
    repository = tmp_path / "repository"
    metadata = tmp_path / "metadata"
    repository.mkdir()
    metadata.mkdir()

    def git(*args: str) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    git("init")
    git("config", "user.name", "CandleScope Tests")
    git("config", "user.email", "tests@candlescope.invalid")
    config = repository / "backend" / "app" / "core" / "config.py"
    config.parent.mkdir(parents=True)
    config.write_text(
        'RESEARCH_DATA_LIBRARY_ENABLED = _parse_strict_flag(\n'
        '    "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",\n'
        '    "0",\n'
        ')\n',
        encoding="utf-8",
    )
    flags = repository / "frontend" / "src" / "features" / "research-data" / "researchDataFlags.ts"
    flags.parent.mkdir(parents=True)
    flags.write_text('return raw === true || raw === 1 || raw === "1";\n', encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "candidate")
    candidate = git("rev-parse", "HEAD")

    manifest = {
        "candidateSha": candidate,
        "effectiveFlags": {name: "0" for name in (
            "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",
            "VITE_RESEARCH_DATA_LIBRARY_ENABLED",
        )},
        "legacyWorktree": {"deleted": False},
        "scope": {
            "oldWorktreeDeleted": False,
            "push": False,
            "merge": False,
            "deploy": False,
            "productionFlagsChanged": False,
        },
        "phaseCommits": {
            f"phase{index}": {"sha": candidate, "subject": "candidate"}
            for index in range(13)
        },
        "artifactPaths": [],
    }
    manifest_path = metadata / "manifest.json"
    schema_path = metadata / "schema.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    schema_path.write_text("{}", encoding="utf-8")

    evidence = repository / "docs" / "evidence" / "result.md"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("qualified\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "evidence")
    assert verify(manifest_path, schema_path, repository)["status"] == "PASS"

    code = repository / "frontend" / "src" / "app.ts"
    code.parent.mkdir(parents=True, exist_ok=True)
    code.write_text("export {};\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "late code")
    with pytest.raises(RuntimeError, match="code changed after the release candidate"):
        verify(manifest_path, schema_path, repository)

    dirty = repository / "dirty.txt"
    dirty.write_text("dirty\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="clean worktree"):
        verify(manifest_path, schema_path, repository)
