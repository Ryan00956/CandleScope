"""Read-only GitHub assessment with no clone, download, build, or execution path."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import tomllib
import xml.etree.ElementTree as ElementTree
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from candlescope_plugin_sdk.platform_v2 import JsonLimits, PlatformContractError, loads_strict

from .errors import github_import_error
from .github import GitHubApiClient, GitHubMetadataClient, repository_api_path
from .models import (
    ASSESSMENT_SCHEMA,
    GITHUB_IMPORT_ENABLED_ENV,
    MAX_ASSESSMENT_BYTES,
    MAX_PACKAGE_METADATA_BYTES,
    PACKAGE_METADATA_PATHS,
    GitHubPin,
    GitHubRepository,
    canonical_sha256,
    require_commit,
)


_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_GITHUB_TOKEN_ENV = ("GITHUB_TOKEN", "GH_TOKEN")
_CONTENT_LIMITS = JsonLimits(
    max_message_bytes=MAX_PACKAGE_METADATA_BYTES,
    max_depth=32,
    max_container_items=50_000,
    max_string_bytes=MAX_PACKAGE_METADATA_BYTES,
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def github_import_enabled(
    environ: Mapping[str, str] | None = None,
    *,
    default: bool = False,
) -> bool:
    raw = (os.environ if environ is None else environ).get(GITHUB_IMPORT_ENABLED_ENV)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise github_import_error(
        "PLUGIN_GITHUB_IMPORT_CONFIGURATION_INVALID",
        f"{GITHUB_IMPORT_ENABLED_ENV} must be one of 1/0, true/false, yes/no, or on/off",
    )


def _object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} must be an object",
            details={"field": field},
        )
    return dict(value)


def _sequence(value: Any, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} must be an array",
            details={"field": field},
        )
    return list(value)


def _string(value: Any, field: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} is invalid",
            details={"field": field},
        )
    return value


def _optional_string(value: Any, field: str, *, maximum: int = 4096) -> str | None:
    if value is None:
        return None
    return _string(value, field, maximum=maximum)


def _integer(value: Any, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} is invalid",
            details={"field": field},
        )
    return value


def _boolean(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} is invalid",
            details={"field": field},
        )
    return value


def _verified(value: Any) -> dict[str, Any]:
    if value is None:
        return {"verified": False, "reason": "not-provided"}
    data = _object(value, "verification")
    verified = data.get("verified")
    reason = data.get("reason")
    if not isinstance(verified, bool) or not isinstance(reason, str) or len(reason) > 128:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            "GitHub verification metadata is invalid",
        )
    return {"verified": verified, "reason": reason}


def _rate(remaining: int | None, current: int | None) -> int | None:
    if remaining is None:
        return current
    return remaining if current is None else min(remaining, current)


def _resolve_pin(
    client: GitHubMetadataClient,
    repository: GitHubRepository,
    pin: GitHubPin,
) -> tuple[dict[str, Any], int | None]:
    remaining: int | None = None
    tag_objects: list[dict[str, Any]] = []
    if pin.kind == "tag":
        result = client.get_object(
            repository_api_path(
                repository.owner,
                repository.name,
                "/git/ref/tags/" + quote(pin.value, safe=""),
            )
        )
        remaining = _rate(result.rate_limit_remaining, remaining)
        ref = _object(result.value, "tag ref")
        object_value = _object(ref.get("object"), "tag ref.object")
        object_type = _string(object_value.get("type"), "tag ref.object.type", maximum=16)
        object_sha = require_commit(object_value.get("sha"), "tag ref.object.sha")
        depth = 0
        while object_type == "tag":
            depth += 1
            if depth > 4:
                raise github_import_error(
                    "PLUGIN_GITHUB_IMPORT_PIN_INVALID",
                    "annotated tag chain exceeds four objects",
                )
            tag_result = client.get_object(
                repository_api_path(
                    repository.owner,
                    repository.name,
                    "/git/tags/" + object_sha,
                )
            )
            remaining = _rate(tag_result.rate_limit_remaining, remaining)
            tag = _object(tag_result.value, "annotated tag")
            if depth == 1 and _string(tag.get("tag"), "annotated tag.tag") != pin.value:
                raise github_import_error(
                    "PLUGIN_GITHUB_IMPORT_PIN_MISMATCH",
                    "GitHub annotated tag name does not match the requested tag",
                )
            target = _object(tag.get("object"), "annotated tag.object")
            tag_objects.append(
                {
                    "sha": object_sha,
                    "tag": _string(tag.get("tag"), "annotated tag.tag"),
                    "verification": _verified(tag.get("verification")),
                }
            )
            object_type = _string(target.get("type"), "annotated tag.object.type", maximum=16)
            object_sha = require_commit(target.get("sha"), "annotated tag.object.sha")
        if object_type != "commit":
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_PIN_INVALID",
                "GitHub tag does not resolve to a commit",
                details={"objectType": object_type},
            )
        commit_sha = object_sha
    else:
        commit_sha = require_commit(pin.value, "pin.commit")

    commit_result = client.get_object(
        repository_api_path(
            repository.owner,
            repository.name,
            "/git/commits/" + commit_sha,
        )
    )
    remaining = _rate(commit_result.rate_limit_remaining, remaining)
    commit = _object(commit_result.value, "commit")
    actual_commit = require_commit(commit.get("sha"), "commit.sha")
    if actual_commit != commit_sha:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_PIN_MISMATCH",
            "GitHub commit response does not match the requested pin",
        )
    tree = _object(commit.get("tree"), "commit.tree")
    tree_sha = require_commit(tree.get("sha"), "commit.tree.sha")
    parents = [
        require_commit(_object(item, "commit.parent").get("sha"), "commit.parent.sha")
        for item in _sequence(commit.get("parents", []), "commit.parents")
    ]
    return (
        {
            "kind": pin.kind,
            "requested": pin.value,
            "commitSha": actual_commit,
            "treeSha": tree_sha,
            "parents": parents,
            "commitVerification": _verified(commit.get("verification")),
            "annotatedTags": tag_objects,
        },
        remaining,
    )


def _release_metadata(
    client: GitHubMetadataClient,
    repository: GitHubRepository,
    pin: GitHubPin,
) -> tuple[dict[str, Any], int | None]:
    if pin.kind != "tag":
        return {"status": "not-requested-for-commit-pin", "assets": []}, None
    result = client.get_object(
        repository_api_path(
            repository.owner,
            repository.name,
            "/releases/tags/" + quote(pin.value, safe=""),
        ),
        allow_not_found=True,
    )
    if result.status_code == 404:
        return {"status": "not-published", "assets": []}, result.rate_limit_remaining
    release = _object(result.value, "release")
    if _string(release.get("tag_name"), "release.tag_name") != pin.value:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_PIN_MISMATCH",
            "GitHub Release tag does not match the requested pin",
        )
    assets: list[dict[str, Any]] = []
    for raw in _sequence(release.get("assets", []), "release.assets"):
        asset = _object(raw, "release.asset")
        url = _string(asset.get("browser_download_url"), "release.asset.url")
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in {
            "github.com",
            "objects.githubusercontent.com",
        }:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
                "GitHub Release asset URL left approved HTTPS hosts",
            )
        digest = _optional_string(asset.get("digest"), "release.asset.digest", maximum=128)
        if digest is not None and _SHA256.fullmatch(digest) is None:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
                "GitHub Release asset digest is not SHA-256",
            )
        assets.append(
            {
                "id": _integer(asset.get("id"), "release.asset.id", minimum=1),
                "name": _string(asset.get("name"), "release.asset.name", maximum=512),
                "size": _integer(asset.get("size"), "release.asset.size"),
                "contentType": _string(
                    asset.get("content_type"),
                    "release.asset.content_type",
                    maximum=256,
                ),
                "state": _string(asset.get("state"), "release.asset.state", maximum=32),
                "url": url,
                "sha256": digest,
            }
        )
    return (
        {
            "status": "published",
            "id": _integer(release.get("id"), "release.id", minimum=1),
            "tag": pin.value,
            "name": _optional_string(release.get("name"), "release.name", maximum=512),
            "draft": _boolean(release.get("draft"), "release.draft"),
            "prerelease": _boolean(release.get("prerelease"), "release.prerelease"),
            "publishedAt": _optional_string(
                release.get("published_at"), "release.published_at", maximum=64
            ),
            "assets": sorted(assets, key=lambda item: (str(item["name"]), int(item["id"]))),
        },
        result.rate_limit_remaining,
    )


def _decode_content(value: dict[str, Any], field: str) -> bytes:
    encoding = _string(value.get("encoding"), f"{field}.encoding", maximum=32)
    if encoding != "base64":
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} content is not base64",
        )
    encoded = _string(value.get("content"), f"{field}.content", maximum=1024 * 1024)
    compact = "".join(encoded.split())
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} content is invalid base64",
        ) from exc
    declared_size = _integer(value.get("size"), f"{field}.size")
    if len(decoded) != declared_size or len(decoded) > MAX_PACKAGE_METADATA_BYTES:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"GitHub {field} content size is invalid",
        )
    return decoded


def _package_projection(path: str, content: bytes) -> dict[str, Any]:
    projection: dict[str, Any] = {}
    try:
        if path in {"Cargo.toml", "pyproject.toml"}:
            data = tomllib.loads(content.decode("utf-8"))
            table_name = "package" if path == "Cargo.toml" else "project"
            table = data.get(table_name, {})
            if isinstance(table, dict):
                for key in ("name", "version", "license", "rust-version", "requires-python"):
                    if isinstance(table.get(key), str):
                        projection[key] = table[key][:512]
        elif path == "package.json":
            value = loads_strict(content, limits=_CONTENT_LIMITS)
            if isinstance(value, dict):
                for key in ("name", "version", "license", "type"):
                    if isinstance(value.get(key), str):
                        projection[key] = value[key][:512]
        elif path == "pom.xml":
            root = ElementTree.fromstring(content)
            for key in ("artifactId", "version", "name"):
                found = root.find(f"{{*}}{key}")
                if found is not None and found.text:
                    projection[key] = found.text.strip()[:512]
        elif path == "go.mod":
            lines = content.decode("utf-8").splitlines()
            for line in lines[:50]:
                stripped = line.strip()
                if stripped.startswith("module "):
                    projection["module"] = stripped[7:][:512]
                elif stripped.startswith("go "):
                    projection["go"] = stripped[3:][:64]
    except (UnicodeError, ValueError, ElementTree.ParseError, PlatformContractError):
        projection = {"parseStatus": "unparsed"}
    return projection


def _content_metadata(
    client: GitHubMetadataClient,
    repository: GitHubRepository,
    commit_sha: str,
) -> tuple[list[dict[str, Any]], int | None]:
    metadata: list[dict[str, Any]] = []
    remaining: int | None = None
    for path in PACKAGE_METADATA_PATHS:
        result = client.get_object(
            repository_api_path(
                repository.owner,
                repository.name,
                "/contents/" + quote(path, safe=""),
            ),
            params={"ref": commit_sha},
            allow_not_found=True,
        )
        remaining = _rate(result.rate_limit_remaining, remaining)
        if result.status_code == 404:
            continue
        value = _object(result.value, f"contents.{path}")
        content = _decode_content(value, f"contents.{path}")
        if _string(value.get("path"), f"contents.{path}.path") != path:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_PIN_MISMATCH",
                "GitHub package metadata path does not match the requested path",
            )
        metadata.append(
            {
                "path": path,
                "blobSha": require_commit(value.get("sha"), f"contents.{path}.sha"),
                "size": len(content),
                "sha256": "sha256:" + hashlib.sha256(content).hexdigest(),
                "projection": _package_projection(path, content),
            }
        )
    return metadata, remaining


def _license_metadata(
    client: GitHubMetadataClient,
    repository: GitHubRepository,
    commit_sha: str,
) -> tuple[dict[str, Any], int | None]:
    result = client.get_object(
        repository_api_path(repository.owner, repository.name, "/license"),
        params={"ref": commit_sha},
        allow_not_found=True,
    )
    if result.status_code == 404:
        return {"status": "not-detected"}, result.rate_limit_remaining
    value = _object(result.value, "license")
    content = _decode_content(value, "license")
    license_value = _object(value.get("license"), "license.license")
    return (
        {
            "status": "detected",
            "path": _string(value.get("path"), "license.path", maximum=512),
            "blobSha": require_commit(value.get("sha"), "license.sha"),
            "size": len(content),
            "sha256": "sha256:" + hashlib.sha256(content).hexdigest(),
            "spdx": _optional_string(license_value.get("spdx_id"), "license.spdx", maximum=128),
            "name": _optional_string(license_value.get("name"), "license.name", maximum=256),
        },
        result.rate_limit_remaining,
    )


def _project_classification(
    repository: dict[str, Any],
    languages: dict[str, int],
    packages: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    primary = _optional_string(repository.get("language"), "repository.language", maximum=128)
    paths = {str(item["path"]) for item in packages}
    if "Cargo.toml" in paths:
        project_type, template = "library-or-cli", "native-cli"
    elif "pom.xml" in paths or "build.gradle" in paths or "build.gradle.kts" in paths:
        project_type, template = "java-library-or-application", "java-library"
    elif "pyproject.toml" in paths:
        project_type, template = "python-package", "python-package"
    elif "package.json" in paths:
        project_type, template = "node-library-or-application", "node-library"
    else:
        project_type, template = "manual-classification-required", None
    return {
        "primaryLanguage": primary,
        "languages": [
            {"name": key, "bytes": value}
            for key, value in sorted(languages.items(), key=lambda item: (-item[1], item[0]))
        ],
        "projectType": project_type,
        "suggestedTemplate": template,
        "humanConfirmationRequired": True,
    }


def assess_github_repository(
    repository_url: str,
    pin: GitHubPin,
    *,
    allow_network: bool,
    enabled: bool | None = None,
    client: GitHubMetadataClient | None = None,
    now: Callable[[], str] = _utc_now,
) -> dict[str, Any]:
    repository = GitHubRepository.parse(repository_url)
    effective_enabled = github_import_enabled() if enabled is None else enabled
    if not isinstance(effective_enabled, bool):
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_CONFIGURATION_INVALID",
            "GitHub import enabled state must be a boolean",
        )
    if not effective_enabled:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_FEATURE_DISABLED",
            f"set {GITHUB_IMPORT_ENABLED_ENV}=1 only for an explicit assessment",
        )
    if allow_network is not True:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_NETWORK_CONFIRMATION_REQUIRED",
            "assessment requires the explicit --allow-network confirmation",
        )
    api_token = next(
        (os.environ[name] for name in _GITHUB_TOKEN_ENV if os.environ.get(name)),
        None,
    )
    metadata_client = client or GitHubApiClient(token=api_token)
    remaining: int | None = None

    repository_result = metadata_client.get_object(
        repository_api_path(repository.owner, repository.name)
    )
    remaining = _rate(repository_result.rate_limit_remaining, remaining)
    repository_data = _object(repository_result.value, "repository")
    full_name = _string(repository_data.get("full_name"), "repository.full_name")
    if full_name.casefold() != repository.slug.casefold():
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_REPOSITORY_MISMATCH",
            "GitHub repository metadata does not match the requested repository",
        )
    if repository_data.get("private") is not False:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_PRIVATE_REPOSITORY_UNSUPPORTED",
            "Phase 9 assessment supports public GitHub repositories only",
        )

    pin_metadata, pin_remaining = _resolve_pin(metadata_client, repository, pin)
    remaining = _rate(pin_remaining, remaining)
    release, release_remaining = _release_metadata(metadata_client, repository, pin)
    remaining = _rate(release_remaining, remaining)

    languages_result = metadata_client.get_object(
        repository_api_path(repository.owner, repository.name, "/languages")
    )
    remaining = _rate(languages_result.rate_limit_remaining, remaining)
    language_raw = _object(languages_result.value, "languages")
    languages = {
        _string(key, "language.name", maximum=128): _integer(value, "language.bytes")
        for key, value in language_raw.items()
    }
    packages, package_remaining = _content_metadata(
        metadata_client, repository, str(pin_metadata["commitSha"])
    )
    remaining = _rate(package_remaining, remaining)
    license_metadata, license_remaining = _license_metadata(
        metadata_client, repository, str(pin_metadata["commitSha"])
    )
    remaining = _rate(license_remaining, remaining)

    repository_license = repository_data.get("license")
    repository_license_spdx = None
    if repository_license is not None:
        repository_license_spdx = _optional_string(
            _object(repository_license, "repository.license").get("spdx_id"),
            "repository.license.spdx_id",
            maximum=128,
        )
    assets = list(release.get("assets", []))
    published_assets_have_digest = bool(assets) and all(
        isinstance(item, dict) and _SHA256.fullmatch(str(item.get("sha256", "")))
        for item in assets
    )
    assessment: dict[str, Any] = {
        "schemaVersion": ASSESSMENT_SCHEMA,
        "generatedAt": now(),
        "input": {
            "repositoryUrl": repository.url,
            "pin": {"kind": pin.kind, "value": pin.value},
            "networkConfirmed": True,
        },
        "behavior": {
            "apiOrigin": "https://api.github.com",
            "readOnlyMetadata": True,
            "clonedRepository": False,
            "downloadedReleaseAssets": False,
            "executedRepositoryCode": False,
            "executedWorkflow": False,
            "executedInstallScript": False,
            "executedBinary": False,
        },
        "repository": {
            "owner": repository.owner,
            "name": repository.name,
            "slug": repository.slug,
            "url": repository.url,
            "archived": _boolean(repository_data.get("archived"), "repository.archived"),
            "disabled": _boolean(repository_data.get("disabled"), "repository.disabled"),
            "fork": _boolean(repository_data.get("fork"), "repository.fork"),
            "defaultBranchObservedOnly": _string(
                repository_data.get("default_branch"),
                "repository.default_branch",
                maximum=256,
            ),
            "repositoryLicenseSpdx": repository_license_spdx,
        },
        "resolvedPin": pin_metadata,
        "release": release,
        "license": license_metadata,
        "packageMetadata": packages,
        "classification": _project_classification(repository_data, languages, packages),
        "readiness": {
            "stableCommitPinned": True,
            "licenseDetected": license_metadata.get("status") == "detected",
            "publishedAssetsHaveGitHubSha256": published_assets_have_digest,
            "artifactDigestsConfirmedByUser": False,
            "dependencyLicensesReviewed": False,
            "stablePublicApiReviewed": False,
            "capabilitiesReviewed": False,
            "deterministicOfflineBuildProven": False,
            "marketplaceEligible": False,
            "localBuildEligible": False,
        },
        "decision": {
            "status": "assessment-only",
            "mayBuild": False,
            "mayInstall": False,
            "mayExecute": False,
            "nextStep": "human-review-and-complete-source-lock",
        },
        "rateLimitRemaining": remaining,
    }
    assessment["assessmentSha256"] = canonical_sha256(assessment)
    return assessment


def _markdown_cell(value: Any) -> str:
    if value is None:
        return "未提供"
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ")[:1000]


def render_assessment_markdown(assessment: Mapping[str, Any]) -> str:
    if assessment.get("schemaVersion") != ASSESSMENT_SCHEMA:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_CONTRACT_INVALID",
            "assessment schema is unsupported",
        )
    repository = _object(assessment.get("repository"), "assessment.repository")
    pin = _object(assessment.get("resolvedPin"), "assessment.resolvedPin")
    release = _object(assessment.get("release"), "assessment.release")
    license_value = _object(assessment.get("license"), "assessment.license")
    classification = _object(assessment.get("classification"), "assessment.classification")
    assets = _sequence(release.get("assets", []), "assessment.release.assets")
    packages = _sequence(
        assessment.get("packageMetadata", []), "assessment.packageMetadata"
    )
    lines = [
        f"# {_markdown_cell(repository.get('slug'))} CandleScope 接入评估",
        "",
        "> 状态：`ASSESSMENT_ONLY_NOT_EXECUTABLE`",
        ">",
        "> 本报告只读取固定 GitHub API 元数据；没有 clone、下载 Release asset、运行 workflow、",
        "> install script、构建脚本或二进制。报告不是安装授权，也不是 Marketplace 审核。",
        "",
        "## 1. 固定身份",
        "",
        "| 字段 | 值 |",
        "| --- | --- |",
        f"| Repository | `{_markdown_cell(repository.get('url'))}` |",
        f"| 请求 pin | `{_markdown_cell(pin.get('kind'))}:{_markdown_cell(pin.get('requested'))}` |",
        f"| Commit | `{_markdown_cell(pin.get('commitSha'))}` |",
        f"| Tree | `{_markdown_cell(pin.get('treeSha'))}` |",
        f"| Commit signature | `{_markdown_cell(_object(pin.get('commitVerification'), 'commitVerification').get('verified'))}` |",
        f"| Assessment SHA-256 | `{_markdown_cell(assessment.get('assessmentSha256'))}` |",
        "",
        "默认分支只作为观察元数据，不作为依赖 pin。",
        "",
        "## 2. Release 与资产",
        "",
        f"Release 状态：`{_markdown_cell(release.get('status'))}`。助手未下载任何资产。",
        "",
        "| Asset | Size | GitHub SHA-256 | URL |",
        "| --- | ---: | --- | --- |",
    ]
    if assets:
        for raw in assets:
            asset = _object(raw, "assessment.release.asset")
            lines.append(
                "| "
                + " | ".join(
                    (
                        _markdown_cell(asset.get("name")),
                        _markdown_cell(asset.get("size")),
                        f"`{_markdown_cell(asset.get('sha256'))}`",
                        _markdown_cell(asset.get("url")),
                    )
                )
                + " |"
            )
    else:
        lines.append("| 无 GitHub Release asset | 0 | 未提供 | - |")
    lines.extend(
        [
            "",
            "没有 GitHub SHA-256 的资产必须由贡献者独立下载、计算摘要并人工写入 source lock；",
            "assessment 不会替贡献者确认它。",
            "",
            "## 3. 许可证与包元数据",
            "",
            "| 项目 | 值 |",
            "| --- | --- |",
            f"| License status | `{_markdown_cell(license_value.get('status'))}` |",
            f"| SPDX | `{_markdown_cell(license_value.get('spdx'))}` |",
            f"| License content SHA-256 | `{_markdown_cell(license_value.get('sha256'))}` |",
            f"| 初步项目类型 | `{_markdown_cell(classification.get('projectType'))}` |",
            f"| 建议模板 | `{_markdown_cell(classification.get('suggestedTemplate'))}` |",
            "",
            "| Package metadata | Blob SHA | Content SHA-256 | Projection |",
            "| --- | --- | --- | --- |",
        ]
    )
    if packages:
        for raw in packages:
            package = _object(raw, "assessment.packageMetadata.item")
            projection = json.dumps(
                package.get("projection", {}),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            lines.append(
                "| "
                + " | ".join(
                    (
                        _markdown_cell(package.get("path")),
                        f"`{_markdown_cell(package.get('blobSha'))}`",
                        f"`{_markdown_cell(package.get('sha256'))}`",
                        f"`{_markdown_cell(projection)}`",
                    )
                )
                + " |"
            )
    else:
        lines.append("| 未识别 | - | - | `{}` |")
    lines.extend(
        [
            "",
            "## 4. 人工兼容评估（必须填写）",
            "",
            "- [ ] 公共 API 与 breaking-change 策略已审查；",
            "- [ ] 输入输出已映射到 CandleScope schema；",
            "- [ ] 网络、文件、数据库、环境变量、密钥、GPU、线程和子进程已逐项声明；",
            "- [ ] OS/arch/native library 支持范围已核实；",
            "- [ ] 冷启动、热调用、内存、输出、取消和实例隔离已有证据；",
            "- [ ] 所有直接与传递依赖许可证已审核；",
            "- [ ] 上游制品、Adapter 制品和 build receipt 摘要已独立确认；",
            "- [ ] golden corpus、conformance、fresh install/check/update/rollback 已完成；",
            "- [ ] Marketplace 沙箱资格已单独验证；否则只声明 `trusted-local`。",
            "",
            "## 5. 当前决定",
            "",
            "`assessment-only`：不得 build、install 或 execute。下一步是人工审核并完成",
            "`candlescope.adapter-source-lock/1`；scaffold 的 pending lock 不具备执行资格。",
            "",
        ]
    )
    output = "\n".join(lines)
    if len(output.encode("utf-8")) > MAX_ASSESSMENT_BYTES:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_ASSESSMENT_TOO_LARGE",
            "rendered assessment exceeds 8 MiB",
        )
    return output


def write_assessment(
    assessment: Mapping[str, Any],
    output: Path,
    *,
    force: bool = False,
) -> tuple[Path, Path]:
    markdown_path = output.expanduser().resolve(strict=False)
    evidence_path = markdown_path.with_suffix(".json")
    if markdown_path == evidence_path:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_OUTPUT_INVALID",
            "assessment output must be a Markdown path",
        )
    for path in (markdown_path, evidence_path):
        if path.exists() and not force:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_OUTPUT_EXISTS",
                "assessment output already exists; pass --force to replace the exact files",
                details={"path": str(path)},
            )
        if path.exists() and not path.is_file():
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_OUTPUT_INVALID",
                "assessment output target is not a regular file",
                details={"path": str(path)},
            )
    markdown = render_assessment_markdown(assessment)
    evidence = json.dumps(
        dict(assessment),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n"
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    nonce = os.urandom(8).hex()
    markdown_temporary = markdown_path.with_name(markdown_path.name + "." + nonce + ".tmp")
    evidence_temporary = evidence_path.with_name(evidence_path.name + "." + nonce + ".tmp")
    try:
        markdown_temporary.write_text(markdown, encoding="utf-8", newline="\n")
        evidence_temporary.write_text(evidence, encoding="utf-8", newline="\n")
        os.replace(evidence_temporary, evidence_path)
        os.replace(markdown_temporary, markdown_path)
    except OSError as exc:
        for path in (markdown_temporary, evidence_temporary):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_OUTPUT_FAILED",
            "assessment output could not be written atomically",
            details={"errorType": type(exc).__name__},
        ) from exc
    return markdown_path, evidence_path


__all__ = [
    "assess_github_repository",
    "github_import_enabled",
    "render_assessment_markdown",
    "write_assessment",
]
