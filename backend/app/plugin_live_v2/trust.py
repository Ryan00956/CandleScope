"""Build-pinned publisher evidence for the isolated Live authority.

This module does not verify a community publisher signature.  It intentionally
implements the narrower WP-A contract: an activation may become eligible for a
future Live Broker only when every immutable identity field exactly matches a
release record shipped inside the CandleScope Host build.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle
from app.plugin_installer_v2.registry import ActivationRecord
from app.plugin_security_v2.errors import PlatformSecurityError


LIVE_RELEASE_LOCK_SCHEMA_VERSION = 1
PUBLISHER_EVIDENCE_SCHEMA_VERSION = "candlescope.publisher-evidence/1"
FIRST_PARTY_PINNED_TRUST_LEVEL = "first-party-pinned"
DEFAULT_LIVE_RELEASE_LOCK_PATH = Path(__file__).with_name(
    "first-party-live-connectors-v1.json"
)
MAX_LIVE_RELEASE_LOCK_BYTES = 64 * 1024

_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_SEMVER = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


class LiveTrustError(PlatformSecurityError):
    """A Live publisher candidate failed a build-pinned trust check."""


def _error(
    code: str,
    message: str,
    *,
    plugin_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> LiveTrustError:
    return LiveTrustError(code, message, plugin_id, details or {})


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _error("LIVE_RELEASE_LOCK_INVALID", f"{label} must be an object")
    return value


def _only_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise _error(
            "LIVE_RELEASE_LOCK_INVALID",
            f"{label} fields do not match the locked schema",
            details={
                "missingFields": sorted(expected - set(value)),
                "unknownFields": sorted(set(value) - expected),
            },
        )


def _string(
    value: Any,
    label: str,
    *,
    maximum: int,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\0" in value
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        raise _error("LIVE_RELEASE_LOCK_INVALID", f"{label} is invalid")
    return value


@dataclass(frozen=True, slots=True)
class FirstPartyLiveRelease:
    connector_id: str
    plugin_id: str
    version: str
    publisher: str
    bundle_sha256: str
    manifest_sha256: str

    def __post_init__(self) -> None:
        for label, value in (
            ("connector_id", self.connector_id),
            ("plugin_id", self.plugin_id),
            ("publisher", self.publisher),
        ):
            if not isinstance(value, str) or _ID.fullmatch(value) is None:
                raise ValueError(f"{label} is invalid")
        if not isinstance(self.version, str) or _SEMVER.fullmatch(self.version) is None:
            raise ValueError("version is invalid")
        if (
            not isinstance(self.bundle_sha256, str)
            or _SHA256.fullmatch(self.bundle_sha256) is None
            or not isinstance(self.manifest_sha256, str)
            or _SHA256.fullmatch(self.manifest_sha256) is None
        ):
            raise ValueError("release digests are invalid")

    def to_wire(self) -> dict[str, str]:
        return {
            "connectorId": self.connector_id,
            "pluginId": self.plugin_id,
            "version": self.version,
            "publisher": self.publisher,
            "bundleSha256": self.bundle_sha256,
            "manifestSha256": self.manifest_sha256,
        }

    @property
    def record_sha256(self) -> str:
        return _sha256(_canonical_bytes(self.to_wire()))


@dataclass(frozen=True, slots=True)
class FirstPartyLiveReleaseLock:
    releases: tuple[FirstPartyLiveRelease, ...]
    lock_sha256: str
    schema_version: int = LIVE_RELEASE_LOCK_SCHEMA_VERSION

    def __post_init__(self) -> None:
        releases = tuple(self.releases)
        if not all(isinstance(item, FirstPartyLiveRelease) for item in releases):
            raise ValueError("release lock contains an invalid release")
        connector_ids = [item.connector_id for item in releases]
        if len(connector_ids) != len(set(connector_ids)):
            raise ValueError("release lock contains duplicate connector IDs")
        if (
            self.schema_version != LIVE_RELEASE_LOCK_SCHEMA_VERSION
            or not isinstance(self.lock_sha256, str)
            or _SHA256.fullmatch(self.lock_sha256) is None
        ):
            raise ValueError("release lock metadata is invalid")
        object.__setattr__(self, "releases", releases)


@dataclass(frozen=True, slots=True)
class PublisherEvidence:
    plugin_id: str
    connector_id: str
    publisher: str
    publisher_identity: str
    version: str
    bundle_sha256: str
    manifest_sha256: str
    release_record_sha256: str
    release_lock_sha256: str
    trust_level: str = FIRST_PARTY_PINNED_TRUST_LEVEL
    schema_version: str = PUBLISHER_EVIDENCE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        for label, value in (
            ("plugin_id", self.plugin_id),
            ("connector_id", self.connector_id),
            ("publisher", self.publisher),
        ):
            if not isinstance(value, str) or _ID.fullmatch(value) is None:
                raise ValueError(f"{label} is invalid")
        if not isinstance(self.version, str) or _SEMVER.fullmatch(self.version) is None:
            raise ValueError("version is invalid")
        if not isinstance(self.publisher_identity, str) or not self.publisher_identity:
            raise ValueError("publisher_identity is invalid")
        for label, value in (
            ("bundle_sha256", self.bundle_sha256),
            ("manifest_sha256", self.manifest_sha256),
            ("release_record_sha256", self.release_record_sha256),
            ("release_lock_sha256", self.release_lock_sha256),
        ):
            if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
                raise ValueError(f"{label} is invalid")
        if (
            self.trust_level != FIRST_PARTY_PINNED_TRUST_LEVEL
            or self.schema_version != PUBLISHER_EVIDENCE_SCHEMA_VERSION
        ):
            raise ValueError("publisher evidence schema or trust level is invalid")

    def to_wire(self) -> dict[str, str]:
        return {
            "schemaVersion": self.schema_version,
            "trustLevel": self.trust_level,
            "pluginId": self.plugin_id,
            "connectorId": self.connector_id,
            "publisher": self.publisher,
            "publisherIdentity": self.publisher_identity,
            "version": self.version,
            "bundleSha256": self.bundle_sha256,
            "manifestSha256": self.manifest_sha256,
            "releaseRecordSha256": self.release_record_sha256,
            "releaseLockSha256": self.release_lock_sha256,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "PublisherEvidence":
        if not isinstance(value, Mapping):
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "publisher evidence must be an object",
            )
        expected = {
            "schemaVersion",
            "trustLevel",
            "pluginId",
            "connectorId",
            "publisher",
            "publisherIdentity",
            "version",
            "bundleSha256",
            "manifestSha256",
            "releaseRecordSha256",
            "releaseLockSha256",
        }
        if set(value) != expected:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "publisher evidence fields do not match the internal schema",
                details={
                    "missingFields": sorted(expected - set(value)),
                    "unknownFields": sorted(set(value) - expected),
                },
            )
        try:
            return cls(
                schema_version=value["schemaVersion"],
                trust_level=value["trustLevel"],
                plugin_id=value["pluginId"],
                connector_id=value["connectorId"],
                publisher=value["publisher"],
                publisher_identity=value["publisherIdentity"],
                version=value["version"],
                bundle_sha256=value["bundleSha256"],
                manifest_sha256=value["manifestSha256"],
                release_record_sha256=value["releaseRecordSha256"],
                release_lock_sha256=value["releaseLockSha256"],
            )
        except (TypeError, ValueError) as exc:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "publisher evidence values are invalid",
            ) from exc


def load_first_party_live_release_lock(
    path: Path | str = DEFAULT_LIVE_RELEASE_LOCK_PATH,
) -> FirstPartyLiveReleaseLock:
    lock_path = Path(path).expanduser().resolve(strict=False)
    try:
        raw = lock_path.read_bytes()
        if len(raw) > MAX_LIVE_RELEASE_LOCK_BYTES:
            raise _error(
                "LIVE_RELEASE_LOCK_INVALID",
                "first-party Live release lock is too large",
            )
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except LiveTrustError:
        raise
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise _error(
            "LIVE_RELEASE_LOCK_INVALID",
            "unable to read the first-party Live release lock",
            details={"errorType": type(exc).__name__},
        ) from exc

    root = _mapping(value, "first-party Live release lock")
    _only_keys(root, {"schemaVersion", "connectors"}, "first-party Live release lock")
    if root["schemaVersion"] != LIVE_RELEASE_LOCK_SCHEMA_VERSION:
        raise _error(
            "LIVE_RELEASE_LOCK_INVALID",
            "first-party Live release lock schemaVersion is unsupported",
        )
    raw_connectors = root["connectors"]
    if not isinstance(raw_connectors, list):
        raise _error(
            "LIVE_RELEASE_LOCK_INVALID",
            "first-party Live release lock connectors must be an array",
        )

    releases: list[FirstPartyLiveRelease] = []
    expected = {
        "connectorId",
        "pluginId",
        "version",
        "publisher",
        "bundleSha256",
        "manifestSha256",
    }
    for index, raw_release in enumerate(raw_connectors):
        label = f"connectors[{index}]"
        release = _mapping(raw_release, label)
        _only_keys(release, expected, label)
        try:
            releases.append(
                FirstPartyLiveRelease(
                    connector_id=_string(
                        release["connectorId"],
                        f"{label}.connectorId",
                        maximum=128,
                        pattern=_ID,
                    ),
                    plugin_id=_string(
                        release["pluginId"],
                        f"{label}.pluginId",
                        maximum=128,
                        pattern=_ID,
                    ),
                    version=_string(
                        release["version"],
                        f"{label}.version",
                        maximum=64,
                        pattern=_SEMVER,
                    ),
                    publisher=_string(
                        release["publisher"],
                        f"{label}.publisher",
                        maximum=128,
                        pattern=_ID,
                    ),
                    bundle_sha256=_string(
                        release["bundleSha256"],
                        f"{label}.bundleSha256",
                        maximum=71,
                        pattern=_SHA256,
                    ),
                    manifest_sha256=_string(
                        release["manifestSha256"],
                        f"{label}.manifestSha256",
                        maximum=71,
                        pattern=_SHA256,
                    ),
                )
            )
        except ValueError as exc:
            raise _error(
                "LIVE_RELEASE_LOCK_INVALID",
                f"{label} is invalid",
            ) from exc

    connector_ids = [item.connector_id for item in releases]
    if len(connector_ids) != len(set(connector_ids)):
        raise _error(
            "LIVE_RELEASE_LOCK_INVALID",
            "first-party Live release lock contains duplicate connector IDs",
        )
    canonical = {
        "schemaVersion": LIVE_RELEASE_LOCK_SCHEMA_VERSION,
        "connectors": [item.to_wire() for item in releases],
    }
    return FirstPartyLiveReleaseLock(
        tuple(releases),
        lock_sha256=_sha256(_canonical_bytes(canonical)),
    )


class LivePublisherTrustStore:
    """Issue deterministic evidence only for exact build-pinned activations."""

    def __init__(self, release_lock: FirstPartyLiveReleaseLock) -> None:
        if not isinstance(release_lock, FirstPartyLiveReleaseLock):
            raise TypeError("release_lock must be FirstPartyLiveReleaseLock")
        self.release_lock = release_lock
        self._by_connector = {
            item.connector_id: item for item in release_lock.releases
        }

    @classmethod
    def from_path(
        cls,
        path: Path | str = DEFAULT_LIVE_RELEASE_LOCK_PATH,
    ) -> "LivePublisherTrustStore":
        return cls(load_first_party_live_release_lock(path))

    @staticmethod
    def _publisher_identity(release: FirstPartyLiveRelease) -> str:
        return (
            f"first-party-lock:{release.publisher}:"
            f"{release.record_sha256.removeprefix('sha256:')}"
        )

    def issue_for_verified_activation(
        self,
        record: ActivationRecord,
        bundle: VerifiedPlatformBundle,
        *,
        connector_id: str,
        trust_level: str,
    ) -> PublisherEvidence:
        """Issue evidence for the immediate result of static installer verification.

        The caller must obtain ``bundle`` from
        ``PlatformPluginInstaller.verify_activation_static(record)``.  The
        independently pinned release record then prevents a valid local
        digest receipt from being promoted to first-party Live identity.
        """

        if not isinstance(record, ActivationRecord) or not isinstance(
            bundle, VerifiedPlatformBundle
        ):
            raise TypeError("record and bundle must be verified installer models")
        if trust_level != FIRST_PARTY_PINNED_TRUST_LEVEL:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "Live authority requires an explicitly pinned first-party platform",
                plugin_id=record.plugin_id,
                details={"reason": "trust-level"},
            )
        if record.state != "active" or not record.enabled:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "Live authority requires an active immutable activation",
                plugin_id=record.plugin_id,
                details={"reason": "activation-state"},
            )
        release = self._by_connector.get(connector_id)
        if release is None:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "connector is not present in the Host build release lock",
                plugin_id=record.plugin_id,
                details={"reason": "connector-not-pinned"},
            )

        candidate = {
            "pluginId": record.plugin_id,
            "version": record.version,
            "publisher": record.publisher,
            "bundleSha256": record.bundle_sha256,
            "manifestSha256": record.manifest_sha256,
        }
        bundle_identity = {
            "pluginId": bundle.manifest.plugin.id,
            "version": bundle.manifest.plugin.version,
            "publisher": bundle.manifest.plugin.publisher,
            "bundleSha256": bundle.sha256,
            "manifestSha256": bundle.manifest_sha256,
        }
        release_identity = {
            "pluginId": release.plugin_id,
            "version": release.version,
            "publisher": release.publisher,
            "bundleSha256": release.bundle_sha256,
            "manifestSha256": release.manifest_sha256,
        }
        mismatches = sorted(
            key
            for key in candidate
            if candidate[key] != bundle_identity[key]
            or candidate[key] != release_identity[key]
        )
        if record.installation_id != bundle.installation_id:
            mismatches.append("installationId")
        if mismatches:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "activation does not exactly match the pinned Live release",
                plugin_id=record.plugin_id,
                details={"mismatchFields": sorted(set(mismatches))},
            )

        return PublisherEvidence(
            plugin_id=release.plugin_id,
            connector_id=release.connector_id,
            publisher=release.publisher,
            publisher_identity=self._publisher_identity(release),
            version=release.version,
            bundle_sha256=release.bundle_sha256,
            manifest_sha256=release.manifest_sha256,
            release_record_sha256=release.record_sha256,
            release_lock_sha256=self.release_lock.lock_sha256,
        )

    def verify_evidence(self, evidence: PublisherEvidence) -> FirstPartyLiveRelease:
        if not isinstance(evidence, PublisherEvidence):
            raise TypeError("evidence must be PublisherEvidence")
        release = self._by_connector.get(evidence.connector_id)
        expected = (
            release is not None
            and evidence.plugin_id == release.plugin_id
            and evidence.publisher == release.publisher
            and evidence.publisher_identity == self._publisher_identity(release)
            and evidence.version == release.version
            and evidence.bundle_sha256 == release.bundle_sha256
            and evidence.manifest_sha256 == release.manifest_sha256
            and evidence.release_record_sha256 == release.record_sha256
            and evidence.release_lock_sha256 == self.release_lock.lock_sha256
            and evidence.trust_level == FIRST_PARTY_PINNED_TRUST_LEVEL
            and evidence.schema_version == PUBLISHER_EVIDENCE_SCHEMA_VERSION
        )
        if not expected or release is None:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "publisher evidence is not valid for this Host build",
                plugin_id=evidence.plugin_id,
                details={"reason": "evidence-mismatch"},
            )
        return release

    def verify_binding_metadata(
        self,
        *,
        plugin_id: str,
        connector_id: str,
        publisher_identity: str,
        version: str,
        bundle_sha256: str,
        manifest_sha256: str,
        release_record_sha256: str,
        release_lock_sha256: str,
    ) -> FirstPartyLiveRelease:
        """Revalidate persisted credential metadata without reconstructing evidence."""

        release = self._by_connector.get(connector_id)
        expected = (
            release is not None
            and plugin_id == release.plugin_id
            and publisher_identity == self._publisher_identity(release)
            and version == release.version
            and bundle_sha256 == release.bundle_sha256
            and manifest_sha256 == release.manifest_sha256
            and release_record_sha256 == release.record_sha256
            and release_lock_sha256 == self.release_lock.lock_sha256
        )
        if not expected or release is None:
            raise _error(
                "LIVE_PUBLISHER_EVIDENCE_REJECTED",
                "persisted publisher evidence is not valid for this Host build",
                plugin_id=plugin_id,
                details={"reason": "binding-mismatch"},
            )
        return release
