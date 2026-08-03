"""Opt-in GitHub assessment and safe Adapter scaffolding for schema v3."""

from .errors import GitHubImportError, github_import_error
from .assessment import assess_github_repository, github_import_enabled
from .build import build_reviewed_adapter_bundle, validate_adapter_source
from .models import (
    ADAPTER_TEMPLATE_KINDS,
    ASSESSMENT_SCHEMA,
    BUILD_RECEIPT_SCHEMA,
    GITHUB_IMPORT_ENABLED_ENV,
    SOURCE_LOCK_SCHEMA,
    GitHubPin,
    GitHubRepository,
)
from .scaffold import SCAFFOLD_SCHEMA, ScaffoldResult, scaffold_adapter

__all__ = [
    "ADAPTER_TEMPLATE_KINDS",
    "ASSESSMENT_SCHEMA",
    "BUILD_RECEIPT_SCHEMA",
    "GITHUB_IMPORT_ENABLED_ENV",
    "SCAFFOLD_SCHEMA",
    "SOURCE_LOCK_SCHEMA",
    "GitHubImportError",
    "GitHubPin",
    "GitHubRepository",
    "ScaffoldResult",
    "assess_github_repository",
    "build_reviewed_adapter_bundle",
    "github_import_error",
    "github_import_enabled",
    "scaffold_adapter",
    "validate_adapter_source",
]
