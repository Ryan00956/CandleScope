from __future__ import annotations

import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / "CHANGELOG.md"
PYPROJECT = ROOT / "pyproject.toml"
RELEASE_DOC = ROOT / "docs" / "reference" / "release_process.md"
PINE_LIKE_API_MATRIX = ROOT / "docs" / "reference" / "pine_like_api_matrix.md"
CHECK_PS1 = ROOT / "scripts" / "check.ps1"
CHECK_SH = ROOT / "scripts" / "check.sh"


def test_release_process_documents_version_policy_and_gates() -> None:
    body = RELEASE_DOC.read_text(encoding="utf-8")
    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))

    for required in (
        "Patch releases should not break public root imports",
        "Minor releases may add public APIs",
        "Any breaking change must include",
        "scripts/check.ps1",
        "scripts/check.sh",
        "pyne_runtime/py.typed",
        "python -m pyne_runtime schema",
        "CHANGELOG.md",
    ):
        assert required in body

    assert "hatchling>=1.25" in project["project"]["optional-dependencies"]["dev"]


def test_release_process_links_to_contract_docs() -> None:
    body = RELEASE_DOC.read_text(encoding="utf-8")

    for required in (
        "../api/public_api.md",
        "pine_like_api_matrix.md",
        "schema_migrations.md",
        "../../CHANGELOG.md",
    ):
        assert f"]({required})" in body


def test_changelog_tracks_unreleased_and_current_project_version() -> None:
    changelog = CHANGELOG.read_text(encoding="utf-8")
    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    version = project["project"]["version"]

    assert "## Unreleased" in changelog
    assert f"## {version}" in changelog


def test_changelog_records_package_maturity_contracts() -> None:
    changelog = CHANGELOG.read_text(encoding="utf-8")

    for required in (
        "schema contracts",
        "schema migration policy",
        "release process guidance",
        "host integration guide",
        "package smoke coverage",
        "py.typed",
    ):
        assert required in changelog


def test_pine_like_api_matrix_tracks_completed_capture_gates() -> None:
    body = PINE_LIKE_API_MATRIX.read_text(encoding="utf-8")

    for required in (
        "21/21 captured fixtures with 0 diff",
        "all 27 strategy pine-equivalent cases are TradingView parity-gated",
        "Host-facing request provider contract examples",
    ):
        assert required in body

    assert "Additional request-context TradingView captures" not in body


def test_full_check_scripts_use_repo_local_temp_root() -> None:
    powershell_body = CHECK_PS1.read_text(encoding="utf-8")
    shell_body = CHECK_SH.read_text(encoding="utf-8")

    for required in (
        ".pyne-check-tmp",
        "PYNE_CHECK_TMP",
        "no:cacheprovider",
        "--basetemp",
        "--no-isolation",
    ):
        assert required in powershell_body

    for required in (
        ".pyne-check-tmp",
        "PYNE_CHECK_TMP",
        "no:cacheprovider",
        "--basetemp",
        "--no-isolation",
        "--offline",
    ):
        assert required in shell_body

    assert "--offline" in powershell_body
