from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from app.plugin_runtime_registry_v3 import (
    RuntimeLicenseFile,
    RuntimeProbe,
    RuntimeRegistryError,
    RuntimeRelease,
    canonical_bytes,
    project_runtime_evidence_bytes,
    sha256_bytes,
)
from app.plugin_runtime_registry_v3.service import _extract_tar


ASSET_URL = (
    "https://api.github.com/repos/bytecodealliance/wasmtime/releases/assets/496894603"
)
ARCHIVE_URL = (
    "https://github.com/bytecodealliance/wasmtime/releases/download/"
    "v47.0.3/wasmtime-v47.0.3-x86_64-windows.zip"
)
COMMIT_SHA = "5554cc1a651da536af2cc46c7324bdc085b162e3"
COMMIT_URL = (
    "https://api.github.com/repos/bytecodealliance/wasmtime/git/commits/" + COMMIT_SHA
)


def test_github_release_asset_projection_is_canonical_and_ignores_mutable_fields() -> (
    None
):
    source = {
        "id": 496894603,
        "name": "wasmtime-v47.0.3-x86_64-windows.zip",
        "size": 13283825,
        "digest": "sha256:"
        "80ddf037820b35a9a53c13519632f52947e848d6ba69a483840b7330110408f3",
        "state": "uploaded",
        "content_type": "application/zip",
        "created_at": "2026-07-31T16:22:31Z",
        "updated_at": "2026-07-31T16:22:32Z",
        "browser_download_url": ARCHIVE_URL,
        "url": ASSET_URL,
        "download_count": 1,
    }
    first = project_runtime_evidence_bytes(
        canonical_bytes(source),
        projection="github-release-asset-v1",
        source_url=ASSET_URL,
    )
    source["download_count"] = 999_999
    second = project_runtime_evidence_bytes(
        canonical_bytes(source),
        projection="github-release-asset-v1",
        source_url=ASSET_URL,
    )

    assert first == second
    assert first == canonical_bytes(
        {
            "schemaVersion": "candlescope.github-release-asset-evidence/1",
            "browserDownloadUrl": ARCHIVE_URL,
            "contentType": "application/zip",
            "createdAt": "2026-07-31T16:22:31Z",
            "digest": source["digest"],
            "id": 496894603,
            "name": source["name"],
            "size": 13283825,
            "state": "uploaded",
            "updatedAt": "2026-07-31T16:22:32Z",
            "url": ASSET_URL,
        }
    )


def test_github_commit_projection_requires_a_verified_pgp_signature() -> None:
    source = {
        "sha": COMMIT_SHA,
        "tree": {"sha": "c48fdb3d3530ac038f149f17d9e35f0a554ec0ec"},
        "parents": [{"sha": "99b0bc39d447317a4102c056081c83a9a84a46e0"}],
        "author": {
            "name": "wasmtime-publish",
            "email": "wasmtime-publish@users.noreply.github.com",
            "date": "2026-07-31T15:45:43Z",
        },
        "committer": {
            "name": "GitHub",
            "email": "noreply@github.com",
            "date": "2026-07-31T15:45:43Z",
        },
        "message": "Release Wasmtime 47.0.3",
        "verification": {
            "verified": True,
            "reason": "valid",
            "signature": (
                "-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n"
            ),
            "payload": "tree c48fdb3d3530ac038f149f17d9e35f0a554ec0ec\n",
            "verified_at": "2026-07-31T15:45:44Z",
        },
    }
    projected = project_runtime_evidence_bytes(
        canonical_bytes(source),
        projection="github-git-commit-v1",
        source_url=COMMIT_URL,
    )
    assert projected == canonical_bytes(
        {
            "schemaVersion": "candlescope.github-git-commit-evidence/1",
            "author": source["author"],
            "committer": source["committer"],
            "message": source["message"],
            "parents": [source["parents"][0]["sha"]],
            "sha": COMMIT_SHA,
            "tree": source["tree"]["sha"],
            "verification": {
                "payload": source["verification"]["payload"],
                "reason": "valid",
                "signature": source["verification"]["signature"],
                "verified": True,
                "verifiedAt": "2026-07-31T15:45:44Z",
            },
        }
    )

    source["verification"]["verified"] = False
    with pytest.raises(RuntimeRegistryError) as failure:
        project_runtime_evidence_bytes(
            canonical_bytes(source),
            projection="github-git-commit-v1",
            source_url=COMMIT_URL,
        )
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_EVIDENCE_INVALID"


def test_tar_xz_extraction_honors_signed_inventory(tmp_path: Path) -> None:
    executable = b"wasmtime fixture\n"
    license_bytes = b"Apache-2.0 WITH LLVM-exception\n"
    archive = tmp_path / "runtime.tar.xz"
    with tarfile.open(archive, "w:xz") as package:
        for name, payload, mode in (
            ("wasmtime-fixture/wasmtime", executable, 0o755),
            ("wasmtime-fixture/LICENSE", license_bytes, 0o444),
        ):
            entry = tarfile.TarInfo(name)
            entry.size = len(payload)
            entry.mode = mode
            entry.mtime = 0
            package.addfile(entry, io.BytesIO(payload))
    release = RuntimeRelease(
        runtime_id="wasmtime-fixture",
        kind="wasm",
        version="1.0.0",
        operating_system="linux",
        architecture="x86_64",
        url="https://github.com/example/runtime.tar.xz",
        sha256=sha256_bytes(archive.read_bytes()),
        size=archive.stat().st_size,
        archive_format="tar.xz",
        strip_prefix="wasmtime-fixture",
        executable="wasmtime",
        extracted_size=len(executable) + len(license_bytes),
        file_count=2,
        license_spdx="Apache-2.0 WITH LLVM-exception",
        license_name="Apache License 2.0 with LLVM Exceptions",
        license_url="https://github.com/example/LICENSE",
        legal_directory=".",
        legal_file_count=1,
        legal_size=len(license_bytes),
        license_files=(
            RuntimeLicenseFile(
                "LICENSE", sha256_bytes(license_bytes), len(license_bytes)
            ),
        ),
        evidence=(),
        probe=RuntimeProbe(("wasmtime", "--version"), 0, "fixture", "(?s)^$", 5),
        upstream_release_url="https://github.com/example/release",
        upstream_scm_ref="fixture",
        upstream_build_ref="https://github.com/example/commit",
    )
    destination = tmp_path / "payload"
    destination.mkdir()

    _extract_tar(release, archive, destination)

    assert (destination / "wasmtime").read_bytes() == executable
    assert (destination / "LICENSE").read_bytes() == license_bytes
