"""Strict data contracts for GitHub assessment and adapter source locks."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit

from candlescope_plugin_sdk.platform_v2 import canonical_dumps

from .errors import github_import_error


ASSESSMENT_SCHEMA = "candlescope.github-assessment/1"
SOURCE_LOCK_SCHEMA = "candlescope.adapter-source-lock/1"
BUILD_RECEIPT_SCHEMA = "candlescope.adapter-build-receipt/1"
GITHUB_IMPORT_ENABLED_ENV = "CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED"
MAX_GITHUB_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_PACKAGE_METADATA_BYTES = 512 * 1024
MAX_ASSESSMENT_BYTES = 8 * 1024 * 1024
MAX_REPOSITORY_COMPONENT_CHARS = 100
MAX_TAG_CHARS = 255
PACKAGE_METADATA_PATHS = (
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Cargo.toml",
    "pyproject.toml",
    "package.json",
    "go.mod",
    "CMakeLists.txt",
)
ADAPTER_TEMPLATE_KINDS = (
    "java-library",
    "native-cli",
    "python-package",
    "node-library",
    "wasm-computation",
    "service",
    "sandbox-view",
)

_REPOSITORY_COMPONENT = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


def _text(value: Any, field: str, *, maximum: int) -> str:
    if not isinstance(value, str):
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_CONTRACT_INVALID",
            f"{field} must be a string",
            details={"field": field},
        )
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or "\x00" in normalized:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_CONTRACT_INVALID",
            f"{field} is empty or exceeds its limit",
            details={"field": field, "maxChars": maximum},
        )
    return normalized


@dataclass(frozen=True, slots=True)
class GitHubRepository:
    owner: str
    name: str

    def __post_init__(self) -> None:
        for field, value in (("owner", self.owner), ("name", self.name)):
            normalized = _text(
                value,
                f"repository.{field}",
                maximum=MAX_REPOSITORY_COMPONENT_CHARS,
            )
            if _REPOSITORY_COMPONENT.fullmatch(normalized) is None:
                raise github_import_error(
                    "PLUGIN_GITHUB_IMPORT_REPOSITORY_INVALID",
                    f"repository {field} is invalid",
                    details={"field": field},
                )
            object.__setattr__(self, field, normalized)

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def url(self) -> str:
        return f"https://github.com/{self.slug}"

    @classmethod
    def parse(cls, value: str) -> "GitHubRepository":
        raw = _text(value, "repositoryUrl", maximum=512)
        parsed = urlsplit(raw)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "github.com"
            or parsed.port is not None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_REPOSITORY_INVALID",
                "repository URL must be an exact public https://github.com/owner/repository URL",
            )
        path = unquote(parsed.path)
        if "\\" in path or "\x00" in path:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_REPOSITORY_INVALID",
                "repository URL path is invalid",
            )
        components = path.split("/")
        if (
            len(components) != 3
            or components[0] != ""
            or not components[1]
            or not components[2]
        ):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_REPOSITORY_INVALID",
                "repository URL must contain exactly owner and repository",
            )
        name = components[2]
        if name.casefold().endswith(".git"):
            name = name[:-4]
        return cls(components[1], name)


@dataclass(frozen=True, slots=True)
class GitHubPin:
    kind: str
    value: str

    def __post_init__(self) -> None:
        if self.kind not in {"tag", "commit"}:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_PIN_INVALID",
                "GitHub pin kind must be tag or commit",
            )
        maximum = MAX_TAG_CHARS if self.kind == "tag" else 40
        normalized = _text(self.value, f"pin.{self.kind}", maximum=maximum)
        if any(character in normalized for character in ("\x00", "\r", "\n")):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_PIN_INVALID",
                "GitHub pin contains forbidden characters",
            )
        if self.kind == "commit" and _COMMIT.fullmatch(normalized) is None:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_PIN_INVALID",
                "commit pins must use a full lowercase 40-character SHA-1",
            )
        if self.kind == "tag" and (
            normalized.startswith("-")
            or normalized.startswith("/")
            or normalized.endswith("/")
            or ".." in normalized
            or "@{" in normalized
            or "\\" in normalized
        ):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_PIN_INVALID",
                "tag pin is not a safe immutable Git ref name",
            )
        object.__setattr__(self, "value", normalized)


def require_commit(value: Any, field: str = "commit") -> str:
    normalized = _text(value, field, maximum=40)
    if _COMMIT.fullmatch(normalized) is None:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
            f"{field} is not a full commit SHA",
            details={"field": field},
        )
    return normalized


def require_sha256(value: Any, field: str) -> str:
    normalized = _text(value, field, maximum=71)
    if _SHA256.fullmatch(normalized) is None:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_SOURCE_LOCK_INVALID",
            f"{field} must be a lowercase sha256 digest",
            details={"field": field},
        )
    return normalized


def canonical_sha256(value: Any) -> str:
    import hashlib

    return "sha256:" + hashlib.sha256(canonical_dumps(value).encode("utf-8")).hexdigest()


__all__ = [
    "ADAPTER_TEMPLATE_KINDS",
    "ASSESSMENT_SCHEMA",
    "BUILD_RECEIPT_SCHEMA",
    "GITHUB_IMPORT_ENABLED_ENV",
    "GitHubPin",
    "GitHubRepository",
    "MAX_ASSESSMENT_BYTES",
    "MAX_GITHUB_RESPONSE_BYTES",
    "MAX_PACKAGE_METADATA_BYTES",
    "PACKAGE_METADATA_PATHS",
    "SOURCE_LOCK_SCHEMA",
    "canonical_sha256",
    "require_commit",
    "require_sha256",
]
