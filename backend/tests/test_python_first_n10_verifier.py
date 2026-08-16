from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from app.backtest.python_first_n10 import (
    FRONTEND_FLAGS,
    PRODUCTION_FLAGS,
    RELEASE_SCHEMA,
    REQUIRED_GATES,
    VALIDATED_STATUS,
)
from scripts.verify_backtest_python_first_n10 import verify


ROOT = Path(__file__).resolve().parents[2]
SCHEMA = (
    ROOT
    / "docs"
    / "perf-baselines"
    / "backtest"
    / "python-first-n10-release.schema.json"
)


def _git(repository: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=repository,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return completed.stdout.strip()


def _write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8", newline="\n")


def _commit(repository: Path, message: str) -> str:
    _git(repository, "add", "--all")
    _git(repository, "commit", "-m", message)
    return _git(repository, "rev-parse", "HEAD")


def _release_repository(tmp_path: Path) -> tuple[Path, Path, str, str]:
    repository = tmp_path / "repository"
    repository.mkdir()
    _git(repository, "init", "-b", "codex/backtest-foundation")
    _git(repository, "config", "user.name", "CandleScope Tests")
    _git(repository, "config", "user.email", "tests@candlescope.invalid")
    _git(repository, "config", "core.autocrlf", "false")

    _write(repository / "README.md", "base\n")
    base = _commit(repository, "base")
    _git(repository, "branch", "main", base)

    artifact = repository / "backend" / "candidate.txt"
    _write(artifact, "candidate artifact\n")
    candidate = _commit(repository, "candidate")
    artifact_sha256 = hashlib.sha256(artifact.read_bytes()).hexdigest()

    manifest_path = repository / "docs" / "evidence" / "n10.json"
    manifest = {
        "schemaVersion": RELEASE_SCHEMA,
        "baseSha": base,
        "gitSha": candidate,
        "gitDirty": False,
        "branch": "codex/backtest-foundation",
        "status": VALIDATED_STATUS,
        "merged": False,
        "pushed": False,
        "productionEnabled": False,
        "pythonIdentities": {
            "authorContract": "candlescope.python-strategy/1",
            "providerProtocol": "strategy-provider/1",
            "bundleSchema": "candlescope.python-strategy-bundle/1",
            "runtimeProfile": "python-strategy-runtime/1",
            "wireTransport": "strict-jsonl/1",
        },
        "effectiveFlags": {
            name: "0" for name in (*PRODUCTION_FLAGS, *FRONTEND_FLAGS)
        },
        "datasetSnapshotHashes": ["sha256:dataset"],
        "hashes": {
            "decision": "sha256:decision",
            "fill": "sha256:fill",
            "ledger": None,
            "report": "sha256:report",
        },
        "artifactPaths": [
            {
                "kind": "candidate",
                "path": "backend/candidate.txt",
                "sha256": artifact_sha256,
            }
        ],
        "gates": {name: "PASS" for name in REQUIRED_GATES},
        "knownLimitations": [],
    }
    _write(manifest_path, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    _commit(repository, "evidence")
    return repository, manifest_path, base, candidate


def test_verifier_binds_clean_candidate_and_evidence_only_head(tmp_path: Path) -> None:
    repository, manifest, base, candidate = _release_repository(tmp_path)

    result = verify(manifest, SCHEMA, repository)

    assert result["status"] == "PASS"
    assert result["baseSha"] == base
    assert result["candidateSha"] == candidate
    assert result["postCandidateChangedPaths"] == ["docs/evidence/n10.json"]


def test_verifier_rejects_code_after_candidate(tmp_path: Path) -> None:
    repository, manifest, _, _ = _release_repository(tmp_path)
    _write(repository / "backend" / "late.py", "late = True\n")
    _commit(repository, "late code")

    with pytest.raises(RuntimeError, match="non-evidence files changed"):
        verify(manifest, SCHEMA, repository)


def test_verifier_rejects_a_dirty_worktree(tmp_path: Path) -> None:
    repository, manifest, _, _ = _release_repository(tmp_path)
    _write(repository / "untracked.txt", "dirty\n")

    with pytest.raises(RuntimeError, match="worktree is dirty"):
        verify(manifest, SCHEMA, repository)
