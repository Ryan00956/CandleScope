from __future__ import annotations

from pathlib import Path


GUIDE = (
    Path(__file__).resolve().parents[1]
    / "docs"
    / "tutorials"
    / "host_integration_guide.md"
)


def test_host_integration_guide_covers_embed_contracts() -> None:
    body = GUIDE.read_text(encoding="utf-8")

    for required in (
        "pn.schema()",
        "scriptNamespace",
        "result.param_schema",
        "RequestCapabilities",
        "RequestMetadata",
        "renderables",
        "strategyReport",
        "pn.validate",
        "scripts/check.ps1",
    ):
        assert required in body


def test_host_integration_guide_links_to_release_and_validation_docs() -> None:
    body = GUIDE.read_text(encoding="utf-8")

    for target in (
        "../reference/error_codes.md",
        "../development/quality_gates.md",
        "../reference/schema_migrations.md",
        "../reference/release_process.md",
    ):
        assert f"]({target})" in body
