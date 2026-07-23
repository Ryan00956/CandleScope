from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from app.plugin_installer_v2.registry import ActivationRecord, EntrypointActivation
from app.plugin_live_v2 import (
    DEFAULT_LIVE_RELEASE_LOCK_PATH,
    LivePublisherTrustStore,
    LiveTrustError,
    load_first_party_live_release_lock,
)
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


def _activation(bundle: Any, root: Path) -> ActivationRecord:
    identity = bundle.manifest.plugin
    entrypoint = bundle.manifest.backend_entrypoints[0]
    return ActivationRecord(
        plugin_id=identity.id,
        name=identity.name,
        version=identity.version,
        publisher=identity.publisher,
        installation_id=bundle.installation_id,
        bundle_sha256=bundle.sha256,
        manifest_sha256=bundle.manifest_sha256,
        activation_id="live-trust-test",
        activated_at="2026-07-23T00:00:00Z",
        state="active",
        enabled=True,
        restart_required=False,
        required_permissions=tuple(
            item.id for item in bundle.manifest.permissions.required
        ),
        entrypoints=(
            EntrypointActivation(
                id=entrypoint.id,
                executable=Path(sys.executable),
                module=entrypoint.python_module,
                working_directory=root,
            ),
        ),
    )


def _release(bundle: Any, **overrides: str) -> dict[str, str]:
    identity = bundle.manifest.plugin
    value = {
        "connectorId": "candlescope.test-live",
        "pluginId": identity.id,
        "version": identity.version,
        "publisher": identity.publisher,
        "bundleSha256": bundle.sha256,
        "manifestSha256": bundle.manifest_sha256,
    }
    value.update(overrides)
    return value


def _write_lock(path: Path, connectors: list[dict[str, str]]) -> Path:
    path.write_text(
        json.dumps(
            {"schemaVersion": 1, "connectors": connectors},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path


def test_exact_build_pinned_activation_issues_deterministic_evidence(
    tmp_path: Path,
) -> None:
    bundle = build_hello_platform_bundle(tmp_path / "bundle").bundle
    record = _activation(bundle, tmp_path)
    lock_path = _write_lock(tmp_path / "live-lock.json", [_release(bundle)])
    trust = LivePublisherTrustStore.from_path(lock_path)

    first = trust.issue_for_verified_activation(
        record,
        bundle,
        connector_id="candlescope.test-live",
        trust_level="first-party-pinned",
    )
    second = trust.issue_for_verified_activation(
        record,
        bundle,
        connector_id="candlescope.test-live",
        trust_level="first-party-pinned",
    )

    assert first == second
    assert first.publisher_identity.startswith("first-party-lock:candlescope:")
    assert first.release_record_sha256.startswith("sha256:")
    assert first.release_lock_sha256 == trust.release_lock.lock_sha256
    assert trust.verify_evidence(first).connector_id == "candlescope.test-live"
    assert first.to_wire() == {
        "schemaVersion": "candlescope.publisher-evidence/1",
        "trustLevel": "first-party-pinned",
        "pluginId": "candlescope.hello-command",
        "connectorId": "candlescope.test-live",
        "publisher": "candlescope",
        "publisherIdentity": first.publisher_identity,
        "version": "0.1.0",
        "bundleSha256": bundle.sha256,
        "manifestSha256": bundle.manifest_sha256,
        "releaseRecordSha256": first.release_record_sha256,
        "releaseLockSha256": first.release_lock_sha256,
    }


@pytest.mark.parametrize("trust_level", ["local-trusted", "untrusted"])
def test_local_or_untrusted_activation_never_receives_live_evidence(
    tmp_path: Path,
    trust_level: str,
) -> None:
    bundle = build_hello_platform_bundle(tmp_path / trust_level).bundle
    trust = LivePublisherTrustStore.from_path(
        _write_lock(tmp_path / f"{trust_level}.json", [_release(bundle)])
    )

    with pytest.raises(LiveTrustError) as captured:
        trust.issue_for_verified_activation(
            _activation(bundle, tmp_path),
            bundle,
            connector_id="candlescope.test-live",
            trust_level=trust_level,
        )
    assert captured.value.code == "LIVE_PUBLISHER_EVIDENCE_REJECTED"
    assert captured.value.details == {"reason": "trust-level"}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("pluginId", "candlescope.other"),
        ("version", "0.2.0"),
        ("publisher", "other"),
        ("bundleSha256", "sha256:" + "1" * 64),
        ("manifestSha256", "sha256:" + "2" * 64),
    ],
)
def test_every_release_identity_mismatch_fails_closed(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    bundle = build_hello_platform_bundle(tmp_path / field).bundle
    trust = LivePublisherTrustStore.from_path(
        _write_lock(tmp_path / f"{field}.json", [_release(bundle, **{field: value})])
    )

    with pytest.raises(LiveTrustError) as captured:
        trust.issue_for_verified_activation(
            _activation(bundle, tmp_path),
            bundle,
            connector_id="candlescope.test-live",
            trust_level="first-party-pinned",
        )
    assert captured.value.code == "LIVE_PUBLISHER_EVIDENCE_REJECTED"
    assert field in captured.value.details["mismatchFields"]


def test_activation_and_bundle_mismatch_fails_closed(tmp_path: Path) -> None:
    bundle = build_hello_platform_bundle(tmp_path / "bundle").bundle
    record = replace(
        _activation(bundle, tmp_path),
        manifest_sha256="sha256:" + "3" * 64,
    )
    trust = LivePublisherTrustStore.from_path(
        _write_lock(tmp_path / "lock.json", [_release(bundle)])
    )

    with pytest.raises(LiveTrustError) as captured:
        trust.issue_for_verified_activation(
            record,
            bundle,
            connector_id="candlescope.test-live",
            trust_level="first-party-pinned",
        )
    assert captured.value.details["mismatchFields"] == ["manifestSha256"]


def test_inactive_activation_never_receives_live_evidence(tmp_path: Path) -> None:
    bundle = build_hello_platform_bundle(tmp_path / "bundle").bundle
    record = replace(
        _activation(bundle, tmp_path),
        state="disabled",
        enabled=False,
    )
    trust = LivePublisherTrustStore.from_path(
        _write_lock(tmp_path / "lock.json", [_release(bundle)])
    )

    with pytest.raises(LiveTrustError) as captured:
        trust.issue_for_verified_activation(
            record,
            bundle,
            connector_id="candlescope.test-live",
            trust_level="first-party-pinned",
        )
    assert captured.value.details == {"reason": "activation-state"}


def test_unknown_connector_and_tampered_evidence_are_rejected(tmp_path: Path) -> None:
    bundle = build_hello_platform_bundle(tmp_path / "bundle").bundle
    record = _activation(bundle, tmp_path)
    trust = LivePublisherTrustStore.from_path(
        _write_lock(tmp_path / "lock.json", [_release(bundle)])
    )

    with pytest.raises(LiveTrustError) as captured:
        trust.issue_for_verified_activation(
            record,
            bundle,
            connector_id="candlescope.not-pinned",
            trust_level="first-party-pinned",
        )
    assert captured.value.details == {"reason": "connector-not-pinned"}

    evidence = trust.issue_for_verified_activation(
        record,
        bundle,
        connector_id="candlescope.test-live",
        trust_level="first-party-pinned",
    )
    with pytest.raises(LiveTrustError):
        trust.verify_evidence(replace(evidence, version="0.2.0"))


def test_production_release_lock_is_valid_and_has_no_live_connector() -> None:
    release_lock = load_first_party_live_release_lock(
        DEFAULT_LIVE_RELEASE_LOCK_PATH
    )
    assert release_lock.releases == ()
    assert release_lock.lock_sha256.startswith("sha256:")


@pytest.mark.parametrize(
    "payload",
    [
        '{"schemaVersion":1,"schemaVersion":1,"connectors":[]}',
        '{"schemaVersion":1,"connectors":[],"unknown":true}',
        '{"schemaVersion":2,"connectors":[]}',
        '{"schemaVersion":1,"connectors":{}}',
        '{"schemaVersion":1,"connectors":[{"connectorId":"bad"}]}',
        '{"schemaVersion":NaN,"connectors":[]}',
    ],
)
def test_release_lock_parser_rejects_ambiguous_or_unknown_input(
    tmp_path: Path,
    payload: str,
) -> None:
    path = tmp_path / "invalid.json"
    path.write_text(payload, encoding="utf-8")
    with pytest.raises(LiveTrustError) as captured:
        load_first_party_live_release_lock(path)
    assert captured.value.code == "LIVE_RELEASE_LOCK_INVALID"


def test_release_lock_rejects_duplicate_connector_identity(tmp_path: Path) -> None:
    bundle = build_hello_platform_bundle(tmp_path / "bundle").bundle
    path = _write_lock(
        tmp_path / "duplicate.json",
        [_release(bundle), _release(bundle)],
    )
    with pytest.raises(LiveTrustError, match="duplicate connector"):
        load_first_party_live_release_lock(path)


def test_release_lock_has_a_hard_size_limit(tmp_path: Path) -> None:
    path = tmp_path / "oversized.json"
    path.write_bytes(b" " * (64 * 1024 + 1))
    with pytest.raises(LiveTrustError, match="too large") as captured:
        load_first_party_live_release_lock(path)
    assert captured.value.code == "LIVE_RELEASE_LOCK_INVALID"
