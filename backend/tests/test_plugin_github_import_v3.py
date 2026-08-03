from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import stat
import zipfile
from pathlib import Path
from typing import Any

import pytest

from app.plugin_github_import_v3.assessment import (
    assess_github_repository,
    github_import_enabled,
    render_assessment_markdown,
    write_assessment,
)
from app.plugin_github_import_v3.errors import GitHubImportError
from app.plugin_github_import_v3.github import GitHubApiClient, GitHubApiResult
from app.plugin_github_import_v3.models import GitHubPin, GitHubRepository
from app.plugin_github_import_v3.build import (
    build_reviewed_adapter_bundle,
    validate_adapter_source,
)
from app.plugin_github_import_v3.cli import main as github_import_cli
from app.plugin_github_import_v3.scaffold import scaffold_adapter
from candlescope_plugin_sdk.platform_v2 import PluginManifest, loads_strict


COMMIT = "17f8b3223456789012345678901234567890abcd"
TAG_OBJECT = "27f8b3223456789012345678901234567890abcd"
TREE = "37f8b3223456789012345678901234567890abcd"


def _sha(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _write_json(path: Path, value: dict[str, Any]) -> bytes:
    raw = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")
    path.write_bytes(raw)
    return raw


def _record_hash(value: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(value).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def _build_adapter_wheel(root: Path) -> Path:
    wheel = root / "wheels" / "local_completed_adapter-0.1.0-py3-none-any.whl"
    wheel.parent.mkdir()
    entries = {
        "adapter/__init__.py": (root / "adapter" / "__init__.py").read_bytes(),
        "adapter/main.py": (root / "adapter" / "main.py").read_bytes(),
        "local_completed_adapter-0.1.0.dist-info/METADATA": (
            b"Metadata-Version: 2.4\nName: local-completed-adapter\n"
            b"Version: 0.1.0\nRequires-Python: >=3.11\n\n"
        ),
        "local_completed_adapter-0.1.0.dist-info/WHEEL": (
            b"Wheel-Version: 1.0\nGenerator: CandleScope Phase 9 tests\n"
            b"Root-Is-Purelib: true\nTag: py3-none-any\n\n"
        ),
    }
    record_path = "local_completed_adapter-0.1.0.dist-info/RECORD"
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for path, raw in sorted(entries.items()):
        writer.writerow((path, _record_hash(raw), len(raw)))
    writer.writerow((record_path, "", ""))
    entries[record_path] = record.getvalue().encode("utf-8")
    with zipfile.ZipFile(wheel, "w", allowZip64=True) as archive:
        for path, raw in sorted(entries.items()):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, raw)
    return wheel


def _complete_python_source(tmp_path: Path) -> Path:
    assessment = assess_github_repository(
        "https://github.com/BurntSushi/aho-corasick",
        GitHubPin("tag", "1.1.4"),
        allow_network=True,
        enabled=True,
        client=_FakeGitHub(),
        now=lambda: "2026-08-03T23:00:00Z",
    )
    _, evidence = write_assessment(assessment, tmp_path / "assessment.md")
    root = tmp_path / "complete-adapter"
    scaffold_adapter(
        "python-package",
        "local.completed-adapter",
        root,
        assessment_path=evidence,
    )
    pending = root / "licenses" / "UPSTREAM_LICENSE.pending"
    pending.unlink()
    license_bytes = b"Reviewed MIT license fixture\n"
    license_path = root / "licenses" / "LICENSE-MIT.txt"
    license_path.write_bytes(license_bytes)
    (root / "licenses" / "THIRD_PARTY_NOTICES.txt").write_text(
        "aho-corasick 1.1.4 - MIT OR Unlicense - reviewed fixture\n",
        encoding="utf-8",
        newline="\n",
    )
    transcript_digest = "sha256:" + "3" * 64
    transcript_raw = _write_json(
        root / "conformance" / "control-transcript.json",
        {
            "schemaVersion": "candlescope.plugin-v2-transcript.v1",
            "protocol": "candlescope.plugin/2",
            "transport": "jsonl/1",
            "requests": [
                {
                    "jsonrpc": "2.0",
                    "id": "handshake-1",
                    "generation": 0,
                    "method": "handshake",
                    "params": {},
                }
            ],
            "expected": {
                "responseSha256": ["sha256:" + "2" * 64],
                "transcriptSha256": transcript_digest,
            },
        },
    )
    manifest_path = root / "manifest.json"
    manifest = loads_strict(manifest_path.read_bytes())
    manifest["probes"][0]["sha256"] = transcript_digest
    _write_json(manifest_path, manifest)
    _write_json(
        root / "sbom" / "cyclonedx.json",
        {
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "serialNumber": "urn:uuid:11111111-1111-4111-8111-111111111111",
            "version": 1,
            "components": [
                {
                    "type": "application",
                    "name": "local.completed-adapter",
                    "version": "0.1.0",
                }
            ],
            "dependencies": [],
        },
    )
    wheel_path = _build_adapter_wheel(root)
    entry_path = root / "adapter" / "main.py"
    entry_raw = entry_path.read_bytes()
    receipt_paths = sorted(
        {
            "adapter/main.py",
            "conformance/control-transcript.json",
            "licenses/LICENSE-MIT.txt",
            "licenses/THIRD_PARTY_NOTICES.txt",
            "manifest.json",
            "sbom/cyclonedx.json",
            wheel_path.relative_to(root).as_posix(),
        }
    )
    receipt_raw = _write_json(
        root / "build-receipt.json",
        {
            "schemaVersion": "candlescope.adapter-build-receipt/1",
            "status": "complete",
            "pluginId": "local.completed-adapter",
            "templateKind": "python-package",
            "reviewedCommit": COMMIT,
            "networkAccessDuringBuild": False,
            "sourceCompilation": False,
            "reproducibleBuilds": 2,
            "outputs": [
                {
                    "path": path,
                    "sha256": _sha((root / path).read_bytes()),
                    "size": (root / path).stat().st_size,
                }
                for path in receipt_paths
            ],
        },
    )
    lock_path = root / "source-lock.json"
    lock = loads_strict(lock_path.read_bytes())
    lock["status"] = "complete"
    lock["artifactPins"] = [
        {
            "name": "aho-corasick-1.1.4.crate",
            "role": "upstream-source",
            "url": "https://static.crates.io/crates/aho-corasick/aho-corasick-1.1.4.crate",
            "sha256": "sha256:" + "1" * 64,
            "size": 1,
            "licenseSpdx": "Unlicense OR MIT",
        }
    ]
    lock["licenses"] = {
        "reviewed": True,
        "redistributionApproved": True,
        "files": [
            {
                "name": "aho-corasick LICENSE-MIT",
                "role": "upstream-license",
                "url": "https://github.com/BurntSushi/aho-corasick/blob/1.1.4/LICENSE-MIT",
                "sha256": _sha(license_bytes),
                "size": len(license_bytes),
                "licenseSpdx": "MIT",
                "localPath": "licenses/LICENSE-MIT.txt",
            }
        ],
    }
    lock["adapter"] = {
        "entryArtifact": "adapter.main",
        "entryArtifactSha256": _sha(entry_raw),
        "buildReceipt": "build-receipt.json",
        "buildReceiptSha256": _sha(receipt_raw),
        "conformanceTranscriptSha256": _sha(transcript_raw),
    }
    lock["review"] = {
        "confirmedBy": "phase9-test-reviewer",
        "confirmedAt": "2026-08-03T23:30:00Z",
        "stablePublicApi": True,
        "capabilities": [],
        "generatedSourceContainsHostInternalImports": False,
        "thirdPartyCodeExecutionApproved": True,
        "marketplaceApproved": False,
    }
    _write_json(lock_path, lock)
    return root


class _FakeGitHub:
    def __init__(self) -> None:
        cargo = b'[package]\nname = "aho-corasick"\nversion = "1.1.4"\nlicense = "Unlicense OR MIT"\n'
        license_content = b"MIT OR UNLICENSE placeholder\n"
        self.calls: list[tuple[str, dict[str, str], bool]] = []
        self.values: dict[str, dict[str, Any]] = {
            "/repos/BurntSushi/aho-corasick": {
                "full_name": "BurntSushi/aho-corasick",
                "private": False,
                "archived": False,
                "disabled": False,
                "fork": False,
                "default_branch": "master",
                "language": "Rust",
                "license": {"spdx_id": "Unlicense"},
            },
            "/repos/BurntSushi/aho-corasick/git/ref/tags/1.1.4": {
                "object": {"type": "tag", "sha": TAG_OBJECT}
            },
            f"/repos/BurntSushi/aho-corasick/git/tags/{TAG_OBJECT}": {
                "tag": "1.1.4",
                "object": {"type": "commit", "sha": COMMIT},
                "verification": {"verified": True, "reason": "valid"},
            },
            f"/repos/BurntSushi/aho-corasick/git/commits/{COMMIT}": {
                "sha": COMMIT,
                "tree": {"sha": TREE},
                "parents": [{"sha": "47f8b3223456789012345678901234567890abcd"}],
                "verification": {"verified": True, "reason": "valid"},
            },
            "/repos/BurntSushi/aho-corasick/languages": {"Rust": 200000},
            "/repos/BurntSushi/aho-corasick/contents/Cargo.toml": {
                "path": "Cargo.toml",
                "sha": "57f8b3223456789012345678901234567890abcd",
                "size": len(cargo),
                "encoding": "base64",
                "content": base64.b64encode(cargo).decode("ascii"),
            },
            "/repos/BurntSushi/aho-corasick/license": {
                "path": "LICENSE-MIT",
                "sha": "67f8b3223456789012345678901234567890abcd",
                "size": len(license_content),
                "encoding": "base64",
                "content": base64.b64encode(license_content).decode("ascii"),
                "license": {"spdx_id": "MIT", "name": "MIT License"},
            },
        }

    def get_object(
        self,
        path: str,
        *,
        params: dict[str, str] | None = None,
        allow_not_found: bool = False,
    ) -> GitHubApiResult:
        self.calls.append((path, dict(params or {}), allow_not_found))
        value = self.values.get(path)
        if value is None:
            if allow_not_found:
                return GitHubApiResult(404, None, 42)
            raise AssertionError(f"unexpected GitHub endpoint: {path}")
        return GitHubApiResult(200, value, 42)


@pytest.mark.parametrize(
    "value",
    [
        "http://github.com/owner/repo",
        "https://example.com/owner/repo",
        "https://user:secret@github.com/owner/repo",
        "https://github.com/owner/repo/issues",
        "https://github.com/owner/repo/",
        "https://github.com/owner//repo",
        "https://github.com/owner/repo?tab=readme",
        "https://github.com/owner/%2e%2e",
        "git@github.com:owner/repo.git",
    ],
)
def test_repository_parser_rejects_noncanonical_or_ambiguous_urls(value: str) -> None:
    with pytest.raises(GitHubImportError) as raised:
        GitHubRepository.parse(value)
    assert raised.value.code == "PLUGIN_GITHUB_IMPORT_REPOSITORY_INVALID"


def test_pin_parser_requires_immutable_commit_or_safe_tag() -> None:
    assert GitHubPin("tag", "1.1.4").value == "1.1.4"
    assert GitHubPin("commit", COMMIT).value == COMMIT
    for kind, value in (("commit", "17f8b32"), ("tag", "../main"), ("tag", "a@{b")):
        with pytest.raises(GitHubImportError) as raised:
            GitHubPin(kind, value)
        assert raised.value.code == "PLUGIN_GITHUB_IMPORT_PIN_INVALID"


def test_feature_flag_is_default_off_and_strict() -> None:
    assert github_import_enabled({}) is False
    assert github_import_enabled({"CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED": "on"})
    with pytest.raises(GitHubImportError) as raised:
        github_import_enabled({"CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED": "sometimes"})
    assert raised.value.code == "PLUGIN_GITHUB_IMPORT_CONFIGURATION_INVALID"


def test_assessment_cannot_reach_client_when_disabled_or_unconfirmed() -> None:
    client = _FakeGitHub()
    with pytest.raises(GitHubImportError) as disabled:
        assess_github_repository(
            "https://github.com/BurntSushi/aho-corasick",
            GitHubPin("tag", "1.1.4"),
            allow_network=True,
            enabled=False,
            client=client,
        )
    assert disabled.value.code == "PLUGIN_GITHUB_IMPORT_FEATURE_DISABLED"
    assert client.calls == []
    with pytest.raises(GitHubImportError) as unconfirmed:
        assess_github_repository(
            "https://github.com/BurntSushi/aho-corasick",
            GitHubPin("tag", "1.1.4"),
            allow_network=False,
            enabled=True,
            client=client,
        )
    assert unconfirmed.value.code == "PLUGIN_GITHUB_IMPORT_NETWORK_CONFIRMATION_REQUIRED"
    assert client.calls == []


def test_assessment_resolves_signed_tag_without_downloading_or_executing() -> None:
    assessment = assess_github_repository(
        "https://github.com/BurntSushi/aho-corasick.git",
        GitHubPin("tag", "1.1.4"),
        allow_network=True,
        enabled=True,
        client=_FakeGitHub(),
        now=lambda: "2026-08-03T23:00:00Z",
    )
    assert assessment["resolvedPin"] == {
        "kind": "tag",
        "requested": "1.1.4",
        "commitSha": COMMIT,
        "treeSha": TREE,
        "parents": ["47f8b3223456789012345678901234567890abcd"],
        "commitVerification": {"verified": True, "reason": "valid"},
        "annotatedTags": [
            {
                "sha": TAG_OBJECT,
                "tag": "1.1.4",
                "verification": {"verified": True, "reason": "valid"},
            }
        ],
    }
    assert assessment["release"] == {"status": "not-published", "assets": []}
    assert assessment["license"]["sha256"].startswith("sha256:")
    assert assessment["packageMetadata"][0]["projection"] == {
        "license": "Unlicense OR MIT",
        "name": "aho-corasick",
        "version": "1.1.4",
    }
    assert assessment["classification"]["suggestedTemplate"] == "native-cli"
    assert set(assessment["behavior"].values()) >= {False, True}
    assert not any(
        assessment["behavior"][key]
        for key in (
            "clonedRepository",
            "downloadedReleaseAssets",
            "executedRepositoryCode",
            "executedWorkflow",
            "executedInstallScript",
            "executedBinary",
        )
    )
    assert assessment["decision"] == {
        "status": "assessment-only",
        "mayBuild": False,
        "mayInstall": False,
        "mayExecute": False,
        "nextStep": "human-review-and-complete-source-lock",
    }


def test_markdown_and_machine_evidence_are_atomic_and_non_executable(tmp_path: Path) -> None:
    assessment = assess_github_repository(
        "https://github.com/BurntSushi/aho-corasick",
        GitHubPin("tag", "1.1.4"),
        allow_network=True,
        enabled=True,
        client=_FakeGitHub(),
        now=lambda: "2026-08-03T23:00:00Z",
    )
    markdown = render_assessment_markdown(assessment)
    assert "ASSESSMENT_ONLY_NOT_EXECUTABLE" in markdown
    assert "不得 build、install 或 execute" in markdown
    output, evidence = write_assessment(assessment, tmp_path / "assessment.md")
    assert output.read_text(encoding="utf-8") == markdown
    assert evidence.read_text(encoding="utf-8").endswith("\n")
    with pytest.raises(GitHubImportError) as exists:
        write_assessment(assessment, output)
    assert exists.value.code == "PLUGIN_GITHUB_IMPORT_OUTPUT_EXISTS"


def test_github_client_rejects_arbitrary_origins_and_path_escape() -> None:
    assert GitHubApiClient._url("/repos/owner/repo", {"ref": COMMIT}).startswith(
        "https://api.github.com/repos/owner/repo?"
    )
    for path in (
        "https://evil.example/repos/owner/repo",
        "/repos/owner/../repo",
        "/users/owner",
        "/repos/owner/repo?ref=main",
    ):
        with pytest.raises(GitHubImportError) as raised:
            GitHubApiClient._url(path, None)
        assert raised.value.code == "PLUGIN_GITHUB_IMPORT_INTERNAL_ENDPOINT_INVALID"


def test_github_client_token_is_bounded_and_never_enters_the_url() -> None:
    client = GitHubApiClient(token="github-test-token")
    headers = client._request_headers()
    assert headers["Authorization"] == "Bearer github-test-token"
    assert "github-test-token" not in client._url("/repos/owner/repo", None)
    for token in ("", " leading", "trailing ", "line\nbreak"):
        with pytest.raises(GitHubImportError) as raised:
            GitHubApiClient(token=token)
        assert raised.value.code == "PLUGIN_GITHUB_IMPORT_CONFIGURATION_INVALID"


@pytest.mark.parametrize(
    "template_kind",
    [
        "java-library",
        "native-cli",
        "python-package",
        "node-library",
        "wasm-computation",
        "service",
        "sandbox-view",
    ],
)
def test_all_scaffolds_are_schema_v3_pending_and_non_executable(
    tmp_path: Path,
    template_kind: str,
) -> None:
    root = tmp_path / template_kind
    result = scaffold_adapter(
        template_kind,
        f"local.example-{template_kind}",
        root,
    )
    assert result.root == root.resolve()
    manifest = PluginManifest.from_wire(loads_strict((root / "manifest.json").read_bytes()))
    assert manifest.schema_version == 3
    lock = loads_strict((root / "source-lock.json").read_bytes())
    receipt = loads_strict((root / "build-receipt.json").read_bytes())
    assert lock["status"] == "pending-human-review"
    assert lock["review"]["thirdPartyCodeExecutionApproved"] is False
    assert lock["artifactPins"] == []
    assert receipt["status"] == "pending-human-review"
    assert not (root / ".github").exists()
    assert (root / "ci" / "candlescope-adapter-ci.yml").is_file()
    assert not any(path.is_file() for path in root.glob("runtime/*"))
    source = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for folder in (root / "src", root / "adapter")
        if folder.exists()
        for path in folder.rglob("*")
        if path.is_file()
    ).casefold()
    assert "from app." not in source
    assert "import app." not in source
    assert "backend/app/" not in source


def test_scaffold_copies_non_executable_assessment_but_does_not_promote_it(
    tmp_path: Path,
) -> None:
    assessment = assess_github_repository(
        "https://github.com/BurntSushi/aho-corasick",
        GitHubPin("tag", "1.1.4"),
        allow_network=True,
        enabled=True,
        client=_FakeGitHub(),
        now=lambda: "2026-08-03T23:00:00Z",
    )
    _, evidence = write_assessment(assessment, tmp_path / "assessment.md")
    root = tmp_path / "adapter"
    scaffold_adapter(
        "native-cli",
        "local.aho-corasick",
        root,
        assessment_path=evidence,
    )
    lock = loads_strict((root / "source-lock.json").read_bytes())
    copied = loads_strict((root / "assessment/github-assessment.json").read_bytes())
    assert lock["upstream"]["commit"] == COMMIT
    assert lock["status"] == "pending-human-review"
    assert lock["review"]["thirdPartyCodeExecutionApproved"] is False
    assert copied["decision"]["mayExecute"] is False


def test_scaffold_rejects_assessment_content_with_stale_identity(tmp_path: Path) -> None:
    assessment = assess_github_repository(
        "https://github.com/BurntSushi/aho-corasick",
        GitHubPin("tag", "1.1.4"),
        allow_network=True,
        enabled=True,
        client=_FakeGitHub(),
        now=lambda: "2026-08-03T23:00:00Z",
    )
    assessment["classification"]["suggestedTemplate"] = "service"
    evidence = tmp_path / "tampered-assessment.json"
    _write_json(evidence, assessment)
    with pytest.raises(GitHubImportError) as raised:
        scaffold_adapter(
            "native-cli",
            "local.tampered-assessment",
            tmp_path / "adapter",
            assessment_path=evidence,
        )
    assert raised.value.code == "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID"


def test_scaffold_refuses_existing_output_and_invalid_identity(tmp_path: Path) -> None:
    output = tmp_path / "adapter"
    output.mkdir()
    sentinel = output / "sentinel.txt"
    sentinel.write_text("owned by user", encoding="utf-8")
    with pytest.raises(GitHubImportError) as exists:
        scaffold_adapter("native-cli", "local.valid", output)
    assert exists.value.code == "PLUGIN_ADAPTER_SCAFFOLD_OUTPUT_EXISTS"
    assert sentinel.read_text(encoding="utf-8") == "owned by user"
    with pytest.raises(GitHubImportError) as invalid:
        scaffold_adapter("native-cli", "../invalid", tmp_path / "other")
    assert invalid.value.code == "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID"
    with pytest.raises(GitHubImportError) as publisher:
        scaffold_adapter(
            "native-cli",
            "local.valid",
            tmp_path / "publisher",
            publisher="Not A Local Id",
        )
    assert publisher.value.code == "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID"


def test_pending_scaffold_cannot_be_built(tmp_path: Path) -> None:
    root = tmp_path / "pending"
    scaffold_adapter("python-package", "local.pending", root)
    with pytest.raises(GitHubImportError) as raised:
        validate_adapter_source(root)
    assert raised.value.code == "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE"


def test_completed_source_lock_binds_assessment_artifact_license_and_receipt(
    tmp_path: Path,
) -> None:
    root = _complete_python_source(tmp_path)
    validated = validate_adapter_source(root)
    assert validated.plugin_id == "local.completed-adapter"
    assert validated.upstream_commit == COMMIT
    assert validated.entry_path == "adapter/main.py"
    assert validated.artifact_pins[0]["role"] == "upstream-source"
    assert validated.license_files[0]["localPath"] == "licenses/LICENSE-MIT.txt"


def test_completed_source_lock_detects_entry_tampering(tmp_path: Path) -> None:
    root = _complete_python_source(tmp_path)
    with (root / "adapter" / "main.py").open("ab") as stream:
        stream.write(b"# tampered\n")
    with pytest.raises(GitHubImportError) as raised:
        validate_adapter_source(root)
    assert raised.value.code == "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH"


def test_completed_source_lock_detects_bundled_artifact_tampering(tmp_path: Path) -> None:
    root = _complete_python_source(tmp_path)
    wheel = next((root / "wheels").glob("*.whl"))
    with wheel.open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(GitHubImportError) as raised:
        validate_adapter_source(root)
    assert raised.value.code == "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH"


def test_completed_source_lock_rejects_host_internal_imports(tmp_path: Path) -> None:
    root = _complete_python_source(tmp_path)
    internal = root / "src" / "host_internal.py"
    internal.parent.mkdir(exist_ok=True)
    internal.write_text("from app.plugin_core_v2 import supervisor\n", encoding="utf-8")
    with pytest.raises(GitHubImportError) as raised:
        validate_adapter_source(root)
    assert raised.value.code == "PLUGIN_ADAPTER_SOURCE_HOST_IMPORT_FORBIDDEN"


def test_reviewed_build_and_v3_cli_produce_inspectable_bundle(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    root = _complete_python_source(tmp_path)
    bundle_path = tmp_path / "completed.cspkg"
    validated, bundle = build_reviewed_adapter_bundle(root, bundle_path)
    assert validated.plugin_id == "local.completed-adapter"
    assert bundle.manifest.plugin.id == "local.completed-adapter"
    assert bundle_path.is_file()
    assert github_import_cli(["--json", "source-lock-check", str(root)]) == 0
    check_payload = json.loads(capsys.readouterr().out)
    assert check_payload["sourceLock"]["executionApprovedBySourceLock"] is True
    assert github_import_cli(["--json", "inspect", str(bundle_path)]) == 0
    inspect_payload = json.loads(capsys.readouterr().out)
    assert (
        inspect_payload["bundle"]["manifest"]["plugin"]["id"]
        == "local.completed-adapter"
    )
