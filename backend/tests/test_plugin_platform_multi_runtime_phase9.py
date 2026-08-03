from __future__ import annotations

import json
from pathlib import Path

from scripts import plugin_platform_multi_runtime_phase9 as phase9


REPOSITORY_ROOT = Path(__file__).parents[2]


def test_phase9_contract_fixture_matches_implemented_release() -> None:
    fixture = json.loads(phase9.CONTRACT_PATH.read_text(encoding="utf-8"))
    assert phase9.capture_contract() == fixture
    assert fixture["schemaVersion"] == phase9.CONTRACT_SCHEMA_VERSION
    assert fixture["assessment"] == {
        "assessmentFileSha256": (
            "sha256:c7ba06a5e797dc560dcabb64eb81c0921def9225352a10397ef75604bc1999fe"
        ),
        "assessmentIdentity": (
            "sha256:c2944ab10b1920ad6729fa6bf546e0516e781c30515e594c0f1daada8b37fb5d"
        ),
        "commit": "17f8b32e3b7c845ef3c5429b823804f552f14ec9",
        "commitVerified": True,
        "executedRepositoryCode": False,
        "mayExecute": False,
        "releaseStatus": "not-published",
        "repository": "https://github.com/BurntSushi/aho-corasick",
        "schemaVersion": "candlescope.github-assessment/1",
        "tag": "1.1.4",
        "tagObject": "4fb4e803829ae895e3c11f7a93e05c2a65a6a719",
    }


def test_phase9_helper_and_scaffolds_are_fail_closed() -> None:
    contract = phase9.capture_contract()
    assert contract["helper"] == {
        "binaryExecution": False,
        "clone": False,
        "defaultEnabled": False,
        "fixedApiOrigin": "https://api.github.com",
        "flag": "CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED",
        "installScriptExecution": False,
        "networkConfirmationRequired": True,
        "optionalTokenEnvironments": ["GITHUB_TOKEN", "GH_TOKEN"],
        "pendingSourceLockExecutable": False,
        "releaseAssetDownload": False,
        "repositoryWorkflowExecution": False,
    }
    assert contract["scaffold"]["templates"] == phase9.TEMPLATE_KINDS
    assert contract["scaffold"]["activeWorkflowGenerated"] is False
    assert contract["scaffold"]["hostInternalImportsAllowed"] is False
    assert contract["scaffold"]["receiptBindsEveryPackageInput"] is True


def test_phase9_reference_is_a_thin_public_api_adapter() -> None:
    source = (
        REPOSITORY_ROOT
        / "examples"
        / "plugins"
        / "aho-corasick-adapter"
        / "src"
        / "main.rs"
    ).read_text(encoding="utf-8")
    assert "AhoCorasickBuilder" in source
    assert ".find_iter(" in source
    assert ".find_overlapping_iter(" in source
    assert "from app." not in source.casefold()
    assert "import app." not in source.casefold()
    assert "backend/app/" not in source.casefold()
    assert phase9.capture_contract()["referenceAdapter"]["upstreamAlgorithmCopied"] is False
