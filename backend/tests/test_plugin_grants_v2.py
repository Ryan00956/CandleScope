from __future__ import annotations

import json
from pathlib import Path

import pytest

from candlescope_plugin_sdk.platform_v2 import PluginManifest, canonical_sha256

from app.plugin_security_v2 import AuditLog, GrantStore, PlatformSecurityError
from app.plugin_security_v2.grants import GRANT_STORE_FILE_NAME
from app.plugin_security_v2.scope import classify_scope_change, scope_contains
from tests.plugin_platform_bundle_testkit import hello_platform_manifest


def _store(tmp_path: Path) -> tuple[GrantStore, AuditLog]:
    audit = AuditLog(tmp_path / "audit" / "events")
    return GrantStore(tmp_path / GRANT_STORE_FILE_NAME, audit_log=audit), audit


def _manifest(
    *,
    version: str = "0.1.0",
    required: list[dict[str, object]] | None = None,
    optional: list[dict[str, object]] | None = None,
) -> PluginManifest:
    value = hello_platform_manifest(version=version)
    value["permissions"] = {
        "required": required or [],
        "optional": optional or [],
    }
    value["probes"] = []
    return PluginManifest.from_wire(value)


def _digests(label: str) -> tuple[str, str]:
    return canonical_sha256({"bundle": label}), canonical_sha256({"manifest": label})


def test_scope_comparison_is_fail_closed_and_limit_aware() -> None:
    broad = {
        "symbols": ["BTCUSDT", "ETHUSDT"],
        "limits": {"maxHistoryBars": 1_000},
    }
    narrow = {"symbols": ["BTCUSDT"], "limits": {"maxHistoryBars": 500}}

    assert scope_contains(broad, narrow) is True
    assert scope_contains(narrow, broad) is False
    assert classify_scope_change(broad, narrow) == "narrowed"
    assert classify_scope_change(narrow, broad) == "expanded"
    assert classify_scope_change({"mode": "closed"}, {"mode": "forming"}) == "changed"


def test_grant_store_requires_explicit_initial_grant_and_revocation_is_immediate(
    tmp_path: Path,
) -> None:
    store, audit = _store(tmp_path)
    manifest = _manifest(
        required=[
            {
                "id": "market.bars.read",
                "scope": {"symbols": ["BTCUSDT"], "maxHistoryBars": 1_000},
            }
        ],
        optional=[{"id": "notifications.show", "scope": {}}],
    )
    bundle, manifest_digest = _digests("initial")

    reconciled = store.reconcile(
        manifest, bundle_sha256=bundle, manifest_sha256=manifest_digest
    )
    assert reconciled.changed is True
    assert reconciled.required_satisfied is False
    assert store.summary()[0]["permissions"][0]["decision"] == "pending"

    granted = store.grant(
        manifest,
        bundle_sha256=bundle,
        manifest_sha256=manifest_digest,
        permission_id="market.bars.read",
    )
    assert granted.required_satisfied is True
    assert (
        store.activation_ready(
            manifest,
            bundle_sha256=bundle,
            manifest_sha256=manifest_digest,
        )
        is False
    )
    optional_denied = store.deny(
        manifest,
        bundle_sha256=bundle,
        manifest_sha256=manifest_digest,
        permission_id="notifications.show",
    )
    assert (
        store.activation_ready(
            manifest,
            bundle_sha256=bundle,
            manifest_sha256=manifest_digest,
        )
        is True
    )
    assert [
        item.permission_id
        for item in store.effective_grants(
            manifest, bundle_sha256=bundle, manifest_sha256=manifest_digest
        )
    ] == ["market.bars.read"]

    repeated = store.reconcile(
        manifest, bundle_sha256=bundle, manifest_sha256=manifest_digest
    )
    assert repeated.changed is False
    assert repeated.store_revision == optional_denied.store_revision

    revoked = store.revoke(
        manifest,
        bundle_sha256=bundle,
        manifest_sha256=manifest_digest,
        permission_id="market.bars.read",
    )
    assert revoked.required_satisfied is False
    assert (
        store.effective_grants(
            manifest, bundle_sha256=bundle, manifest_sha256=manifest_digest
        )
        == ()
    )
    assert [item.sequence for item in audit.read_all()] == list(
        range(1, len(audit.read_all()) + 1)
    )


def test_narrowed_scope_inherits_but_expansion_major_and_optional_promotion_do_not(
    tmp_path: Path,
) -> None:
    store, _audit = _store(tmp_path)
    initial = _manifest(
        required=[
            {
                "id": "market.bars.read",
                "scope": {
                    "symbols": ["BTCUSDT", "ETHUSDT"],
                    "maxHistoryBars": 1_000,
                },
            }
        ]
    )
    first_bundle, first_manifest = _digests("first")
    store.reconcile(initial, bundle_sha256=first_bundle, manifest_sha256=first_manifest)
    store.grant(
        initial,
        bundle_sha256=first_bundle,
        manifest_sha256=first_manifest,
        permission_id="market.bars.read",
    )

    narrowed = _manifest(
        version="0.2.0",
        required=[
            {
                "id": "market.bars.read",
                "scope": {"symbols": ["BTCUSDT"], "maxHistoryBars": 500},
            }
        ],
    )
    narrow_bundle, narrow_manifest = _digests("narrow")
    diff = store.permission_diff(
        narrowed,
        bundle_sha256=narrow_bundle,
        manifest_sha256=narrow_manifest,
    )
    assert diff.items[0].change == "narrowed"
    assert diff.requires_confirmation is False
    inherited = store.reconcile(
        narrowed,
        bundle_sha256=narrow_bundle,
        manifest_sha256=narrow_manifest,
    )
    assert inherited.required_satisfied is True
    assert store.summary()[0]["permissions"][0]["source"] == "inherit"

    expanded = _manifest(
        version="0.3.0",
        required=[
            {
                "id": "market.bars.read",
                "scope": {
                    "symbols": ["BTCUSDT", "ETHUSDT"],
                    "maxHistoryBars": 500,
                },
            }
        ],
    )
    expand_bundle, expand_manifest = _digests("expand")
    store.reconcile(
        expanded,
        bundle_sha256=expand_bundle,
        manifest_sha256=expand_manifest,
    )
    assert (
        store.required_satisfied(
            expanded,
            bundle_sha256=expand_bundle,
            manifest_sha256=expand_manifest,
        )
        is False
    )
    assert store.summary()[0]["permissions"][0]["decision"] == "pending"

    major = _manifest(
        version="1.0.0",
        required=[
            {
                "id": "market.bars.read",
                "scope": {"symbols": ["BTCUSDT"], "maxHistoryBars": 500},
            }
        ],
    )
    major_bundle, major_manifest = _digests("major")
    major_diff = store.permission_diff(
        major, bundle_sha256=major_bundle, manifest_sha256=major_manifest
    )
    assert major_diff.major_version_changed is True
    store.reconcile(major, bundle_sha256=major_bundle, manifest_sha256=major_manifest)
    assert store.summary()[0]["permissions"][0]["decision"] == "pending"

    optional = _manifest(
        version="1.1.0",
        optional=[{"id": "notifications.show", "scope": {}}],
    )
    optional_bundle, optional_manifest = _digests("optional")
    store.reconcile(
        optional,
        bundle_sha256=optional_bundle,
        manifest_sha256=optional_manifest,
    )
    store.grant(
        optional,
        bundle_sha256=optional_bundle,
        manifest_sha256=optional_manifest,
        permission_id="notifications.show",
    )
    promoted = _manifest(
        version="1.2.0",
        required=[{"id": "notifications.show", "scope": {}}],
    )
    promoted_bundle, promoted_manifest = _digests("promoted")
    promotion = store.permission_diff(
        promoted,
        bundle_sha256=promoted_bundle,
        manifest_sha256=promoted_manifest,
    )
    assert promotion.items[0].change == "kind-changed"
    assert promotion.items[0].requires_confirmation is True
    store.reconcile(
        promoted,
        bundle_sha256=promoted_bundle,
        manifest_sha256=promoted_manifest,
    )
    assert (
        store.required_satisfied(
            promoted,
            bundle_sha256=promoted_bundle,
            manifest_sha256=promoted_manifest,
        )
        is False
    )


def test_partial_required_grant_high_risk_and_sensitive_scope_fail_closed(
    tmp_path: Path,
) -> None:
    store, _audit = _store(tmp_path)
    manifest = _manifest(
        required=[
            {
                "id": "market.bars.read",
                "scope": {"symbols": ["BTCUSDT", "ETHUSDT"]},
            }
        ],
        optional=[{"id": "trade.submit", "scope": {"maxNotional": 10}}],
    )
    bundle, manifest_digest = _digests("partial")
    store.reconcile(manifest, bundle_sha256=bundle, manifest_sha256=manifest_digest)
    partial = store.grant(
        manifest,
        bundle_sha256=bundle,
        manifest_sha256=manifest_digest,
        permission_id="market.bars.read",
        scope={"symbols": ["BTCUSDT"]},
    )
    assert partial.required_satisfied is False

    with pytest.raises(PlatformSecurityError, match="remain unavailable"):
        store.grant(
            manifest,
            bundle_sha256=bundle,
            manifest_sha256=manifest_digest,
            permission_id="trade.submit",
        )
    with pytest.raises(PlatformSecurityError, match="raw credentials"):
        store.grant(
            manifest,
            bundle_sha256=bundle,
            manifest_sha256=manifest_digest,
            permission_id="market.bars.read",
            scope={"token": "do-not-store-this"},
        )


def test_audit_chain_detects_tampering(tmp_path: Path) -> None:
    store, audit = _store(tmp_path)
    manifest = _manifest(optional=[{"id": "notifications.show", "scope": {}}])
    bundle, manifest_digest = _digests("audit")
    store.reconcile(manifest, bundle_sha256=bundle, manifest_sha256=manifest_digest)
    event_path = next((tmp_path / "audit" / "events").glob("*.json"))
    value = json.loads(event_path.read_text(encoding="utf-8"))
    value["outcome"] = "forged"
    event_path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(PlatformSecurityError, match="hash mismatch"):
        audit.read_all()


def test_audit_chain_rejects_unrecognized_directory_entries(tmp_path: Path) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    audit.append(
        category="test",
        action="append",
        outcome="allowed",
        trace_id="audit-entry-test",
    )
    (audit.directory / "unexpected.txt").write_text("not an event", encoding="utf-8")
    with pytest.raises(PlatformSecurityError, match="unsupported entry"):
        audit.read_all()
