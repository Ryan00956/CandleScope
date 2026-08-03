"""Revocable, runtime-bound trust decisions for local Plugin Platform code."""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import canonical_sha256

from .audit import AuditLog
from .errors import security_error
from .sandbox import restricted_runtime_profile, restricted_runtime_profiles_status
from .storage import atomic_write_json, read_json, security_lock


TRUST_UX_ENABLED_ENV = "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_TRUST_UX_ENABLED"
TRUST_STATE_SCHEMA_VERSION = 1
TRUST_PREVIEW_SCHEMA_VERSION = "candlescope.plugin-trust-preview/1"
TRUST_ALIASES = {
    "first-party-pinned": "first-party-pinned",
    "verified-publisher": "marketplace-sandboxed",
    "marketplace-sandboxed": "marketplace-sandboxed",
    "local-trusted": "trusted-local",
    "trusted-local": "trusted-local",
    "local-developer": "developer-local",
    "developer-local": "developer-local",
    "untrusted": "marketplace-sandboxed",
    "ui-only-untrusted": "ui-only-untrusted",
}
CANONICAL_TRUST_MODES = frozenset(
    {
        "first-party-pinned",
        "marketplace-sandboxed",
        "trusted-local",
        "developer-local",
        "ui-only-untrusted",
    }
)
_TRUST_DECISION_MODES = frozenset({"marketplace-sandboxed", "trusted-local"})
_TRUST_DECISION_SOURCES = frozenset(
    {
        "legacy-alias-migration",
        "local-install-double-confirmation",
        "trust-change-double-confirmation",
    }
)
_CANDIDATE_ID = re.compile(r"^candidate-[0-9a-f]{32}$")
_CHANGE_ID = re.compile(r"^trust-change-[0-9a-f]{32}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_PLUGIN_ID = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$")
_USER_ACTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$")
_MAX_REASON = 500
_MIN_REASON = 12


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime | None = None) -> str:
    return (value or _utc_now()).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or len(value) > 64:
        raise security_error("PLUGIN_TRUST_STATE_INVALID", f"{label} is invalid")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise security_error(
            "PLUGIN_TRUST_STATE_INVALID", f"{label} is invalid"
        ) from exc
    if parsed.tzinfo is None:
        raise security_error("PLUGIN_TRUST_STATE_INVALID", f"{label} is invalid")
    return parsed.astimezone(UTC)


def _bounded_reason(value: Any) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or not _MIN_REASON <= len(value) <= _MAX_REASON
        or any(character in value for character in ("\0", "\r"))
    ):
        raise security_error(
            "PLUGIN_TRUST_REASON_INVALID",
            f"trust reason must contain {_MIN_REASON}-{_MAX_REASON} visible characters",
        )
    return value


def _bounded_actor(value: Any) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or not 1 <= len(value) <= 128
        or any(character in value for character in ("\0", "\r", "\n"))
    ):
        raise security_error("PLUGIN_TRUST_ACTOR_INVALID", "trust actor is invalid")
    return value


def _bounded_user_action_id(value: Any) -> str:
    if not isinstance(value, str) or _USER_ACTION_ID.fullmatch(value) is None:
        raise security_error(
            "PLUGIN_TRUST_USER_ACTION_INVALID",
            "trust confirmation requires a bounded Host user-action identifier",
        )
    return value


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
    except OSError as exc:
        raise security_error(
            "PLUGIN_TRUST_CANDIDATE_INVALID",
            "trust candidate could not be read",
        ) from exc
    return f"sha256:{digest.hexdigest()}", size


def canonical_trust_mode(raw_trust_level: str) -> str:
    try:
        return TRUST_ALIASES[raw_trust_level]
    except KeyError as exc:
        raise security_error(
            "PLUGIN_TRUST_LEVEL_INVALID",
            "bundle trust evidence uses an unsupported alias",
            details={"trustLevel": raw_trust_level},
        ) from exc


@dataclass(frozen=True, slots=True)
class TrustEvidence:
    raw_trust_level: str
    publisher_identity: str
    source: str
    marketplace_id: str | None = None

    def __post_init__(self) -> None:
        canonical_trust_mode(self.raw_trust_level)
        if (
            not isinstance(self.publisher_identity, str)
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
        ):
            raise ValueError("publisher_identity is invalid")
        if (
            not isinstance(self.source, str)
            or not self.source
            or len(self.source) > 128
        ):
            raise ValueError("trust source is invalid")

    @property
    def signature_root(self) -> str | None:
        if self.publisher_identity.startswith("publisher-key:"):
            return self.publisher_identity
        return None

    def to_wire(self) -> dict[str, Any]:
        return {
            "rawTrustLevel": self.raw_trust_level,
            "canonicalDefault": canonical_trust_mode(self.raw_trust_level),
            "publisherIdentity": self.publisher_identity,
            "source": self.source,
            "marketplaceId": self.marketplace_id,
            "signatureRoot": self.signature_root,
        }


@dataclass(frozen=True, slots=True)
class RuntimeAuthorization:
    runtime_identity: str
    authorization_identity: str
    mode: str
    entrypoints: tuple[dict[str, Any], ...]
    signature_roots: tuple[str, ...]
    sandbox: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {
            "runtimeIdentity": self.runtime_identity,
            "authorizationIdentity": self.authorization_identity,
            "mode": self.mode,
            "entrypoints": [dict(item) for item in self.entrypoints],
            "signatureRoots": list(self.signature_roots),
            "sandbox": dict(self.sandbox),
        }


@dataclass(frozen=True, slots=True)
class ClaimedLocalInstall:
    candidate_id: str
    path: Path
    bundle_sha256: str
    preview_sha256: str
    preview: dict[str, Any]
    reason: str
    actor: str
    review_user_action_id: str
    confirmation_user_action_id: str


class PluginTrustService:
    """Own exact trust choices without weakening capability or Live authority."""

    def __init__(
        self,
        *,
        root: Path | str,
        audit_log: AuditLog,
        managed_runtime_registry: Any,
        python_executable: Path | str,
        enabled: bool,
        trust_evidence_resolver: Callable[[Any], TrustEvidence],
        legacy_installed_checker: Callable[[Any], bool] | None = None,
        candidate_ttl_seconds: int = 900,
        review_ttl_seconds: int = 300,
    ) -> None:
        if not isinstance(enabled, bool):
            raise ValueError("trust service enabled must be a boolean")
        if candidate_ttl_seconds < 60 or review_ttl_seconds < 30:
            raise ValueError("trust service expiry is too short")
        self.root = Path(root).resolve(strict=False)
        self.state_path = self.root / "trust-state-v1.json"
        self.lock_path = self.root / ".trust-state-v1.lock"
        self.candidates_directory = self.root / "candidates"
        self.audit_log = audit_log
        self.managed_runtime_registry = managed_runtime_registry
        self.python_executable = Path(python_executable).resolve(strict=False)
        self.enabled = enabled
        self.trust_evidence_resolver = trust_evidence_resolver
        self.legacy_installed_checker = legacy_installed_checker
        self.candidate_ttl = timedelta(seconds=candidate_ttl_seconds)
        self.review_ttl = timedelta(seconds=review_ttl_seconds)

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise security_error(
                "PLUGIN_TRUST_UX_DISABLED", "the Phase 6 trust UX is disabled"
            )

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {
            "schemaVersion": TRUST_STATE_SCHEMA_VERSION,
            "revision": 0,
            "decisions": [],
            "candidates": [],
            "changes": [],
        }

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return self._empty_state()
        state = read_json(self.state_path, "Plugin Trust State")
        if (
            not isinstance(state, dict)
            or set(state)
            != {"schemaVersion", "revision", "decisions", "candidates", "changes"}
            or state["schemaVersion"] != TRUST_STATE_SCHEMA_VERSION
            or isinstance(state["revision"], bool)
            or not isinstance(state["revision"], int)
            or state["revision"] < 0
            or not all(
                isinstance(state[key], list)
                for key in ("decisions", "candidates", "changes")
            )
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "Plugin Trust State schema is invalid"
            )
        for decision in state["decisions"]:
            self._validate_decision(decision)
        for candidate in state["candidates"]:
            self._validate_candidate(candidate)
        for change in state["changes"]:
            self._validate_change(change)
        decision_keys = [
            (item["pluginId"], item["bundleSha256"]) for item in state["decisions"]
        ]
        candidate_ids = [item["candidateId"] for item in state["candidates"]]
        change_ids = [item["changeId"] for item in state["changes"]]
        if (
            len(decision_keys) != len(set(decision_keys))
            or len(candidate_ids) != len(set(candidate_ids))
            or len(change_ids) != len(set(change_ids))
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID",
                "Plugin Trust State contains duplicate identities",
            )
        return state

    @staticmethod
    def _validate_decision(value: Any) -> None:
        expected = {
            "pluginId",
            "bundleSha256",
            "publisherIdentity",
            "runtimeIdentity",
            "authorizationIdentity",
            "mode",
            "source",
            "reason",
            "actor",
            "userActionId",
            "updatedAt",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or not isinstance(value["pluginId"], str)
            or _PLUGIN_ID.fullmatch(value["pluginId"]) is None
            or not all(
                isinstance(value[key], str) and value[key]
                for key in expected - {"pluginId"}
            )
            or _SHA256.fullmatch(value["bundleSha256"]) is None
            or _SHA256.fullmatch(value["runtimeIdentity"]) is None
            or _SHA256.fullmatch(value["authorizationIdentity"]) is None
            or value["mode"] not in _TRUST_DECISION_MODES
            or value["source"] not in _TRUST_DECISION_SOURCES
            or _USER_ACTION_ID.fullmatch(value["userActionId"]) is None
            or len(value["publisherIdentity"]) > 256
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust decision schema is invalid"
            )
        _bounded_reason(value["reason"])
        _bounded_actor(value["actor"])
        _parse_timestamp(value["updatedAt"], "trust decision updatedAt")

    @staticmethod
    def _validate_candidate(value: Any) -> None:
        expected = {
            "candidateId",
            "pluginId",
            "bundleSha256",
            "bundleSize",
            "previewSha256",
            "preview",
            "createdAt",
            "expiresAt",
            "status",
            "review",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or not isinstance(value["candidateId"], str)
            or _CANDIDATE_ID.fullmatch(value["candidateId"]) is None
            or not isinstance(value["pluginId"], str)
            or _PLUGIN_ID.fullmatch(value["pluginId"]) is None
            or isinstance(value["bundleSize"], bool)
            or not isinstance(value["bundleSize"], int)
            or value["bundleSize"] <= 0
            or not isinstance(value["bundleSha256"], str)
            or _SHA256.fullmatch(value["bundleSha256"]) is None
            or not isinstance(value["previewSha256"], str)
            or _SHA256.fullmatch(value["previewSha256"]) is None
            or not isinstance(value["preview"], dict)
            or canonical_sha256(value["preview"]) != value["previewSha256"]
            or value["status"] not in {"prepared", "reviewed", "claimed"}
            or (value["review"] is not None and not isinstance(value["review"], dict))
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust candidate schema is invalid"
            )
        expires_at = _parse_timestamp(value["expiresAt"], "trust candidate expiresAt")
        created_at = _parse_timestamp(value["createdAt"], "trust candidate createdAt")
        if expires_at <= created_at:
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust candidate expiry is invalid"
            )
        preview_plugin = value["preview"].get("plugin")
        if (
            not isinstance(preview_plugin, dict)
            or preview_plugin.get("id") != value["pluginId"]
            or preview_plugin.get("bundleSha256") != value["bundleSha256"]
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID",
                "trust candidate preview identity is invalid",
            )
        review = value["review"]
        if value["status"] == "reviewed":
            PluginTrustService._validate_review(review)
        elif review is not None:
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID",
                "trust candidate review state is invalid",
            )

    @staticmethod
    def _validate_review(value: Any) -> None:
        expected = {
            "reason",
            "acknowledgements",
            "actor",
            "userActionId",
            "tokenSha256",
            "reviewedAt",
            "expiresAt",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or not isinstance(value["acknowledgements"], list)
            or not value["acknowledgements"]
            or not all(
                isinstance(item, str) and 1 <= len(item) <= 256
                for item in value["acknowledgements"]
            )
            or len(value["acknowledgements"]) != len(set(value["acknowledgements"]))
            or not isinstance(value["tokenSha256"], str)
            or _SHA256.fullmatch(value["tokenSha256"]) is None
            or not isinstance(value["userActionId"], str)
            or _USER_ACTION_ID.fullmatch(value["userActionId"]) is None
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust review schema is invalid"
            )
        _bounded_reason(value["reason"])
        _bounded_actor(value["actor"])
        reviewed_at = _parse_timestamp(value["reviewedAt"], "trust review reviewedAt")
        expires_at = _parse_timestamp(value["expiresAt"], "trust review expiresAt")
        if expires_at <= reviewed_at:
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust review expiry is invalid"
            )

    @staticmethod
    def _validate_change(value: Any) -> None:
        expected = {
            "changeId",
            "pluginId",
            "bundleSha256",
            "previewSha256",
            "preview",
            "reason",
            "actor",
            "reviewUserActionId",
            "tokenSha256",
            "createdAt",
            "expiresAt",
        }
        if (
            not isinstance(value, dict)
            or set(value) != expected
            or not isinstance(value["changeId"], str)
            or _CHANGE_ID.fullmatch(value["changeId"]) is None
            or not isinstance(value["preview"], dict)
            or canonical_sha256(value["preview"]) != value["previewSha256"]
            or not isinstance(value["bundleSha256"], str)
            or _SHA256.fullmatch(value["bundleSha256"]) is None
            or not isinstance(value["previewSha256"], str)
            or _SHA256.fullmatch(value["previewSha256"]) is None
            or not isinstance(value["tokenSha256"], str)
            or _SHA256.fullmatch(value["tokenSha256"]) is None
            or not isinstance(value["pluginId"], str)
            or _PLUGIN_ID.fullmatch(value["pluginId"]) is None
            or not isinstance(value["reviewUserActionId"], str)
            or _USER_ACTION_ID.fullmatch(value["reviewUserActionId"]) is None
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust change schema is invalid"
            )
        _bounded_reason(value["reason"])
        _bounded_actor(value["actor"])
        created_at = _parse_timestamp(value["createdAt"], "trust change createdAt")
        expires_at = _parse_timestamp(value["expiresAt"], "trust change expiresAt")
        if (
            expires_at <= created_at
            or value["preview"].get("action") != "trust-change"
            or value["preview"].get("pluginId") != value["pluginId"]
            or value["preview"].get("bundleSha256") != value["bundleSha256"]
            or not isinstance(value["preview"].get("to"), dict)
            or value["preview"]["to"].get("mode") not in _TRUST_DECISION_MODES
        ):
            raise security_error(
                "PLUGIN_TRUST_STATE_INVALID", "trust change binding is invalid"
            )

    def _write_state(self, state: dict[str, Any]) -> None:
        state = {**state, "revision": state["revision"] + 1}
        atomic_write_json(self.state_path, state)

    def _candidate_path(self, candidate_id: str) -> Path:
        if _CANDIDATE_ID.fullmatch(candidate_id) is None:
            raise security_error(
                "PLUGIN_TRUST_CANDIDATE_INVALID", "trust candidate ID is invalid"
            )
        return self.candidates_directory / f"{candidate_id}.cspkg"

    def _purge_expired_locked(self, state: dict[str, Any]) -> dict[str, Any]:
        now = _utc_now()
        active_candidates: list[dict[str, Any]] = []
        changed = False
        for candidate in state["candidates"]:
            if _parse_timestamp(candidate["expiresAt"], "candidate expiresAt") <= now:
                self._candidate_path(candidate["candidateId"]).unlink(missing_ok=True)
                changed = True
            else:
                active_candidates.append(candidate)
        active_changes = [
            item
            for item in state["changes"]
            if _parse_timestamp(item["expiresAt"], "change expiresAt") > now
        ]
        changed = changed or len(active_changes) != len(state["changes"])
        if not changed:
            return state
        updated = {**state, "candidates": active_candidates, "changes": active_changes}
        self._write_state(updated)
        return {**updated, "revision": state["revision"] + 1}

    @staticmethod
    def _artifact_sha256(bundle: Any, relative_path: str | None) -> str | None:
        if relative_path is None:
            return None
        artifact = next(
            (item for item in bundle.envelope.artifacts if item.path == relative_path),
            None,
        )
        if artifact is None:
            raise security_error(
                "PLUGIN_TRUST_RUNTIME_INVALID",
                "runtime artifact is absent from the immutable bundle inventory",
                plugin_id=bundle.manifest.plugin.id,
                details={"artifact": relative_path},
            )
        return artifact.sha256

    def _runtime_entrypoints(self, bundle: Any) -> tuple[dict[str, Any], ...]:
        values: list[dict[str, Any]] = []
        python_digest: str | None = None
        python_size: int | None = None
        for entrypoint in bundle.manifest.normalized_entrypoints:
            runtime = entrypoint.runtime
            kind = runtime.kind
            runtime_id = runtime.runtime_id
            artifact_path = getattr(runtime, "artifact", None)
            artifact_sha256 = self._artifact_sha256(bundle, artifact_path)
            supply_source = "plugin-bundled"
            host_managed = False
            runtime_artifact_sha256 = artifact_sha256
            registry_sha256 = None
            system_runtime_path = None
            runtime_signature_root = None
            if kind == "python-module":
                if python_digest is None:
                    python_digest, python_size = _hash_file(self.python_executable)
                supply_source = "host-python"
                host_managed = True
                runtime_artifact_sha256 = python_digest
                runtime_signature_root = (
                    f"host-python:{sys.version_info.major}.{sys.version_info.minor}"
                )
                system_runtime_path = str(self.python_executable)
            elif kind in {"java-jar", "node-module", "wasm-component"}:
                supply_kind = {
                    "java-jar": "java",
                    "node-module": "node",
                    "wasm-component": "wasm",
                }[kind]
                try:
                    registry, release = self.managed_runtime_registry.resolve(
                        runtime_id, supply_kind
                    )
                except Exception as exc:
                    raise security_error(
                        "PLUGIN_TRUST_RUNTIME_UNAVAILABLE",
                        "the exact Host-managed runtime cannot be resolved for trust review",
                        plugin_id=bundle.manifest.plugin.id,
                        details={"runtimeKind": kind, "runtimeId": runtime_id},
                    ) from exc
                supply_source = "host-managed"
                host_managed = True
                runtime_artifact_sha256 = release.sha256
                registry_sha256 = registry.sha256
                runtime_signature_root = (
                    f"runtime-registry:{registry.registry_id}:{registry.sha256}"
                )
            try:
                profile = restricted_runtime_profile(kind).to_wire()
            except Exception:
                profile = {
                    "profileId": "unavailable",
                    "runtimeKind": kind,
                    "sandboxMode": "unavailable",
                    "sandboxSupported": False,
                    "trustedLocalOnly": True,
                    "networkDefault": "denied",
                    "subprocessDeclared": False,
                    "limits": {"maxProcesses": 1},
                }
            values.append(
                {
                    "entrypointId": entrypoint.id,
                    "runtimeKind": kind,
                    "runtimeId": runtime_id,
                    "descriptor": runtime.to_wire(),
                    "pluginArtifactSha256": artifact_sha256,
                    "runtimeArtifactSha256": runtime_artifact_sha256,
                    "runtimeArtifactSize": python_size
                    if kind == "python-module"
                    else None,
                    "supplySource": supply_source,
                    "hostManaged": host_managed,
                    "registrySha256": registry_sha256,
                    "systemRuntimePath": system_runtime_path,
                    "signatureRoot": runtime_signature_root,
                    "profile": profile,
                }
            )
        return tuple(sorted(values, key=lambda item: item["entrypointId"]))

    @staticmethod
    def _sandbox_summary(
        mode: str, entrypoints: Sequence[Mapping[str, Any]]
    ) -> dict[str, Any]:
        profiles = [item["profile"] for item in entrypoints]
        supported = bool(profiles) and all(
            item["sandboxSupported"] for item in profiles
        )
        requested = mode == "marketplace-sandboxed"
        return {
            "requested": requested,
            "active": requested and supported,
            "status": (
                "windows-appcontainer"
                if requested and supported
                else (
                    "trusted-local-user-approved"
                    if mode == "trusted-local"
                    else "unavailable-trusted-local-only"
                )
            ),
            "supported": supported,
            "trustedLocalOnly": requested and not supported,
            "profiles": profiles,
        }

    def build_authorization(
        self, bundle: Any, evidence: TrustEvidence, *, mode: str
    ) -> RuntimeAuthorization:
        if mode not in CANONICAL_TRUST_MODES:
            raise security_error("PLUGIN_TRUST_MODE_INVALID", "trust mode is invalid")
        entrypoints = self._runtime_entrypoints(bundle)
        runtime_payload = {
            "schemaVersion": 1,
            "pluginId": bundle.manifest.plugin.id,
            "bundleSha256": bundle.sha256,
            "entrypoints": list(entrypoints),
        }
        runtime_identity = canonical_sha256(runtime_payload)
        signature_roots = sorted(
            {
                root
                for root in (
                    evidence.signature_root,
                    *(item["signatureRoot"] for item in entrypoints),
                )
                if root is not None
            }
        )
        authorization_identity = canonical_sha256(
            {
                "schemaVersion": 1,
                "pluginId": bundle.manifest.plugin.id,
                "publisherIdentity": evidence.publisher_identity,
                "signatureRoots": signature_roots,
                "runtimeIdentity": runtime_identity,
                "mode": mode,
            }
        )
        return RuntimeAuthorization(
            runtime_identity,
            authorization_identity,
            mode,
            entrypoints,
            tuple(signature_roots),
            self._sandbox_summary(mode, entrypoints),
        )

    @staticmethod
    def _permission_risks(bundle: Any) -> dict[str, Any]:
        permissions: list[dict[str, Any]] = []
        ids: set[str] = set()
        for kind, requests in (
            ("required", bundle.manifest.permissions.required),
            ("optional", bundle.manifest.permissions.optional),
        ):
            for request in requests:
                ids.add(request.id)
                permissions.append(
                    {
                        "permissionId": request.id,
                        "kind": kind,
                        "scope": dict(request.scope),
                    }
                )
        categories = {
            "network": sorted(item for item in ids if item == "network.connect"),
            "files": sorted(item for item in ids if item.startswith("filesystem.")),
            "secrets": sorted(item for item in ids if item == "secrets.use"),
            "accounts": sorted(item for item in ids if item == "accounts.read"),
            "trading": sorted(item for item in ids if item.startswith("trade.")),
        }
        return {
            "permissions": sorted(permissions, key=lambda item: item["permissionId"]),
            **{
                key: {"requested": bool(value), "permissionIds": value}
                for key, value in categories.items()
            },
            "subprocess": {
                "requested": False,
                "declared": False,
                "maxProcesses": 1,
                "reason": "No processModel is declared; Phase 6 profiles remain single-process.",
            },
            "liveAuthority": {
                "grantedByTrust": False,
                "independentlyProtected": True,
            },
        }

    @staticmethod
    def _runtime_diff(
        previous: RuntimeAuthorization | None, current: RuntimeAuthorization
    ) -> dict[str, Any]:
        before = list(previous.entrypoints) if previous is not None else []
        after = list(current.entrypoints)
        before_pairs = [(item["runtimeKind"], item["runtimeId"]) for item in before]
        after_pairs = [(item["runtimeKind"], item["runtimeId"]) for item in after]
        before_paths = [item["systemRuntimePath"] for item in before]
        after_paths = [item["systemRuntimePath"] for item in after]
        before_roots = list(previous.signature_roots) if previous is not None else []
        after_roots = list(current.signature_roots)
        changed = (
            previous is None or previous.runtime_identity != current.runtime_identity
        )
        return {
            "changed": changed,
            "requiresConfirmation": changed,
            "kindOrIdChanged": before_pairs != after_pairs,
            "signatureRootChanged": before_roots != after_roots,
            "systemRuntimePathChanged": before_paths != after_paths,
            "supplyChanged": previous is None
            or [item["runtimeArtifactSha256"] for item in before]
            != [item["runtimeArtifactSha256"] for item in after],
            "previous": before,
            "current": after,
        }

    @staticmethod
    def _acknowledgements(
        authorization: RuntimeAuthorization, risks: Mapping[str, Any]
    ) -> tuple[str, ...]:
        values = {
            "execute-local-code",
            "sandbox-status",
            "live-authority-separate",
            *(
                f"runtime:{item['entrypointId']}:{item['runtimeKind']}:{item['runtimeId']}"
                for item in authorization.entrypoints
            ),
            *(f"permission:{item['permissionId']}" for item in risks["permissions"]),
        }
        return tuple(sorted(values))

    def _decision_for(
        self, state: Mapping[str, Any], plugin_id: str, bundle_sha256: str
    ) -> dict[str, Any] | None:
        return next(
            (
                item
                for item in state["decisions"]
                if item["pluginId"] == plugin_id
                and item["bundleSha256"] == bundle_sha256
            ),
            None,
        )

    def _legacy_migration_allowed(self, bundle: Any) -> bool:
        return bool(
            self.legacy_installed_checker is not None
            and self.legacy_installed_checker(bundle)
        )

    def _record_decision_locked(
        self,
        state: dict[str, Any],
        *,
        bundle: Any,
        evidence: TrustEvidence,
        authorization: RuntimeAuthorization,
        reason: str,
        actor: str,
        user_action_id: str,
        source: str,
        persist: bool = True,
    ) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any]]:
        previous = self._decision_for(state, bundle.manifest.plugin.id, bundle.sha256)
        decision = {
            "pluginId": bundle.manifest.plugin.id,
            "bundleSha256": bundle.sha256,
            "publisherIdentity": evidence.publisher_identity,
            "runtimeIdentity": authorization.runtime_identity,
            "authorizationIdentity": authorization.authorization_identity,
            "mode": authorization.mode,
            "source": source,
            "reason": reason,
            "actor": actor,
            "userActionId": user_action_id,
            "updatedAt": _timestamp(),
        }
        decisions = [
            item
            for item in state["decisions"]
            if not (
                item["pluginId"] == decision["pluginId"]
                and item["bundleSha256"] == decision["bundleSha256"]
            )
        ]
        decisions.append(decision)
        decisions.sort(key=lambda item: (item["pluginId"], item["bundleSha256"]))
        updated = {**state, "decisions": decisions}
        if persist:
            self._write_state(updated)
            updated = {**updated, "revision": state["revision"] + 1}
        return updated, previous, decision

    def _migrate_legacy_decision(
        self, bundle: Any, evidence: TrustEvidence, authorization: RuntimeAuthorization
    ) -> None:
        with security_lock(self.lock_path):
            state = self._load_state()
            if self._decision_for(state, bundle.manifest.plugin.id, bundle.sha256):
                return
            state, _previous, decision = self._record_decision_locked(
                state,
                bundle=bundle,
                evidence=evidence,
                authorization=authorization,
                reason="Preserve the exact installed local-trusted alias during Phase 6 migration.",
                actor="host-migration",
                user_action_id="legacy-alias-migration",
                source="legacy-alias-migration",
            )
        self.audit_log.append(
            category="trust",
            action="alias-migrate",
            outcome="recorded",
            trace_id="trust-legacy-alias-migration",
            plugin_id=bundle.manifest.plugin.id,
            data={
                "actor": decision["actor"],
                "reason": decision["reason"],
                "bundleSha256": bundle.sha256,
                "authorizationIdentity": authorization.authorization_identity,
                "toMode": authorization.mode,
            },
        )

    def resolve_authorization_identity(self, bundle: Any) -> str | None:
        if not self.enabled:
            return None
        evidence = self.trust_evidence_resolver(bundle)
        default_mode = canonical_trust_mode(evidence.raw_trust_level)
        with security_lock(self.lock_path):
            state = self._load_state()
            decision = self._decision_for(
                state, bundle.manifest.plugin.id, bundle.sha256
            )
        mode = decision["mode"] if decision is not None else default_mode
        if mode == "developer-local":
            mode = "trusted-local"
        authorization = self.build_authorization(bundle, evidence, mode=mode)
        if decision is None and default_mode in {"developer-local", "trusted-local"}:
            if self._legacy_migration_allowed(bundle):
                self._migrate_legacy_decision(bundle, evidence, authorization)
            else:
                raise security_error(
                    "PLUGIN_TRUST_CONFIRMATION_REQUIRED",
                    "local executable code must complete the Phase 6 itemized double confirmation before first execution",
                    plugin_id=bundle.manifest.plugin.id,
                )
        elif decision is not None and any(
            (
                decision["publisherIdentity"] != evidence.publisher_identity,
                decision["runtimeIdentity"] != authorization.runtime_identity,
                decision["authorizationIdentity"]
                != authorization.authorization_identity,
            )
        ):
            raise security_error(
                "PLUGIN_TRUST_BINDING_CHANGED",
                "publisher, signature root, runtime, or trust mode changed after confirmation",
                plugin_id=bundle.manifest.plugin.id,
            )
        return authorization.authorization_identity

    def execution_trust(self, bundle: Any) -> str:
        evidence = self.trust_evidence_resolver(bundle)
        if not self.enabled:
            raw = evidence.raw_trust_level
            if raw == "verified-publisher":
                return "untrusted"
            if raw in {"local-developer", "local-trusted"}:
                return "local-trusted"
            if raw in {"first-party-pinned", "untrusted"}:
                return raw
            raise security_error(
                "PLUGIN_TRUST_LEVEL_INVALID", "legacy execution trust is invalid"
            )
        self.resolve_authorization_identity(bundle)
        with security_lock(self.lock_path):
            state = self._load_state()
            decision = self._decision_for(
                state, bundle.manifest.plugin.id, bundle.sha256
            )
        mode = (
            decision["mode"]
            if decision is not None
            else canonical_trust_mode(evidence.raw_trust_level)
        )
        if mode in {"trusted-local", "developer-local"}:
            return "local-trusted"
        if mode in {"marketplace-sandboxed", "ui-only-untrusted"}:
            return "untrusted"
        if mode == "first-party-pinned":
            return mode
        raise security_error("PLUGIN_TRUST_MODE_INVALID", "execution trust is invalid")

    def _current_authorization(self, bundle: Any | None) -> RuntimeAuthorization | None:
        if bundle is None:
            return None
        evidence = self.trust_evidence_resolver(bundle)
        with security_lock(self.lock_path):
            state = self._load_state()
            decision = self._decision_for(
                state, bundle.manifest.plugin.id, bundle.sha256
            )
        mode = (
            decision["mode"]
            if decision is not None
            else canonical_trust_mode(evidence.raw_trust_level)
        )
        if mode == "developer-local":
            mode = "trusted-local"
        return self.build_authorization(bundle, evidence, mode=mode)

    def build_preview(
        self,
        *,
        bundle: Any,
        evidence: TrustEvidence,
        mode: str,
        permission_diff: Mapping[str, Any],
        previous_bundle: Any | None,
    ) -> dict[str, Any]:
        authorization = self.build_authorization(bundle, evidence, mode=mode)
        risks = self._permission_risks(bundle)
        runtime_diff = self._runtime_diff(
            self._current_authorization(previous_bundle), authorization
        )
        return {
            "schemaVersion": TRUST_PREVIEW_SCHEMA_VERSION,
            "plugin": {
                "id": bundle.manifest.plugin.id,
                "name": bundle.manifest.plugin.name,
                "version": bundle.manifest.plugin.version,
                "publisher": bundle.manifest.plugin.publisher,
                "bundleSha256": bundle.sha256,
                "manifestSha256": bundle.manifest_sha256,
            },
            "source": evidence.to_wire(),
            "authorization": authorization.to_wire(),
            "permissionDiff": dict(permission_diff),
            "runtimeDiff": runtime_diff,
            "requests": risks,
            "requiredAcknowledgements": list(
                self._acknowledgements(authorization, risks)
            ),
            "warning": (
                "trusted-local runs local application code under the current user. "
                "Capability grants, secrets, accounts, and Live authority remain separate."
            ),
        }

    def prepare_local_install(
        self,
        *,
        upload_path: Path,
        bundle: Any,
        preview: Mapping[str, Any],
        user_action_id: str,
    ) -> dict[str, Any]:
        self._require_enabled()
        user_action_id = _bounded_user_action_id(user_action_id)
        raw_path = Path(upload_path)
        if raw_path.is_symlink() or not raw_path.is_file():
            raise security_error(
                "PLUGIN_TRUST_CANDIDATE_INVALID", "local bundle upload is unsafe"
            )
        path = raw_path.resolve(strict=True)
        digest, size = _hash_file(path)
        if digest != bundle.sha256:
            raise security_error(
                "PLUGIN_TRUST_CANDIDATE_INVALID",
                "local bundle digest changed after verification",
            )
        preview_value = dict(preview)
        preview_sha256 = canonical_sha256(preview_value)
        candidate_id = f"candidate-{secrets.token_hex(16)}"
        created = _utc_now()
        candidate = {
            "candidateId": candidate_id,
            "pluginId": bundle.manifest.plugin.id,
            "bundleSha256": digest,
            "bundleSize": size,
            "previewSha256": preview_sha256,
            "preview": preview_value,
            "createdAt": _timestamp(created),
            "expiresAt": _timestamp(created + self.candidate_ttl),
            "status": "prepared",
            "review": None,
        }
        self.candidates_directory.mkdir(parents=True, exist_ok=True)
        if self.candidates_directory.is_symlink():
            raise security_error(
                "PLUGIN_TRUST_CANDIDATE_INVALID", "candidate directory is unsafe"
            )
        destination = self._candidate_path(candidate_id)
        with security_lock(self.lock_path):
            state = self._purge_expired_locked(self._load_state())
            if destination.exists():
                raise security_error(
                    "PLUGIN_TRUST_CANDIDATE_INVALID",
                    "candidate destination is occupied",
                )
            try:
                os.replace(path, destination)
            except OSError as exc:
                raise security_error(
                    "PLUGIN_TRUST_CANDIDATE_INVALID", "candidate could not be staged"
                ) from exc
            try:
                updated = {**state, "candidates": [*state["candidates"], candidate]}
                self._write_state(updated)
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
        self.audit_log.append(
            category="trust",
            action="install-prepare",
            outcome="recorded",
            trace_id=f"management-{user_action_id}",
            plugin_id=bundle.manifest.plugin.id,
            data={
                "actor": "local-desktop-user",
                "userActionId": user_action_id,
                "candidateId": candidate_id,
                "bundleSha256": digest,
                "previewSha256": preview_sha256,
                "codeExecuted": False,
            },
        )
        return {
            "candidateId": candidate_id,
            "previewSha256": preview_sha256,
            "expiresAt": candidate["expiresAt"],
            "preview": preview_value,
        }

    @staticmethod
    def _exact_acknowledgements(
        preview: Mapping[str, Any], acknowledgements: Any
    ) -> tuple[str, ...]:
        expected = preview.get("requiredAcknowledgements")
        if (
            not isinstance(expected, list)
            or not all(isinstance(item, str) and item for item in expected)
            or not isinstance(acknowledgements, Sequence)
            or isinstance(acknowledgements, (str, bytes, bytearray))
            or not all(isinstance(item, str) and item for item in acknowledgements)
            or sorted(set(acknowledgements)) != sorted(expected)
            or len(acknowledgements) != len(set(acknowledgements))
        ):
            raise security_error(
                "PLUGIN_TRUST_ACKNOWLEDGEMENT_INCOMPLETE",
                "every exact trust, runtime, and permission acknowledgement is required",
            )
        return tuple(sorted(acknowledgements))

    def review_local_install(
        self,
        *,
        candidate_id: str,
        preview_sha256: str,
        reason: str,
        acknowledgements: Sequence[str],
        actor: str,
        user_action_id: str,
    ) -> dict[str, Any]:
        self._require_enabled()
        user_action_id = _bounded_user_action_id(user_action_id)
        reason = _bounded_reason(reason)
        actor = _bounded_actor(actor)
        token = f"trust-review-{secrets.token_urlsafe(32)}"
        token_sha256 = canonical_sha256(token)
        with security_lock(self.lock_path):
            state = self._purge_expired_locked(self._load_state())
            candidate = next(
                (
                    item
                    for item in state["candidates"]
                    if item["candidateId"] == candidate_id
                ),
                None,
            )
            if (
                candidate is None
                or candidate["previewSha256"] != preview_sha256
                or candidate["status"] == "claimed"
            ):
                raise security_error(
                    "PLUGIN_TRUST_CANDIDATE_INVALID",
                    "trust candidate is unavailable or changed",
                )
            exact = self._exact_acknowledgements(candidate["preview"], acknowledgements)
            reviewed = _utc_now()
            replacement = {
                **candidate,
                "status": "reviewed",
                "review": {
                    "reason": reason,
                    "acknowledgements": list(exact),
                    "actor": actor,
                    "userActionId": user_action_id,
                    "tokenSha256": token_sha256,
                    "reviewedAt": _timestamp(reviewed),
                    "expiresAt": _timestamp(reviewed + self.review_ttl),
                },
            }
            candidates = [
                replacement if item["candidateId"] == candidate_id else item
                for item in state["candidates"]
            ]
            self._write_state({**state, "candidates": candidates})
        self.audit_log.append(
            category="trust",
            action="install-review",
            outcome="confirmed",
            trace_id=f"management-{user_action_id}",
            plugin_id=candidate["pluginId"],
            data={
                "actor": actor,
                "reason": reason,
                "userActionId": user_action_id,
                "candidateId": candidate_id,
                "previewSha256": preview_sha256,
                "acknowledgements": list(exact),
                "confirmationStep": 1,
                "codeExecuted": False,
            },
        )
        return {
            "candidateId": candidate_id,
            "previewSha256": preview_sha256,
            "confirmationToken": token,
            "expiresAt": replacement["review"]["expiresAt"],
            "confirmationStep": 1,
        }

    def claim_local_install(
        self,
        *,
        candidate_id: str,
        preview_sha256: str,
        confirmation_token: str,
        user_action_id: str,
    ) -> ClaimedLocalInstall:
        self._require_enabled()
        user_action_id = _bounded_user_action_id(user_action_id)
        token_sha256 = canonical_sha256(confirmation_token)
        with security_lock(self.lock_path):
            state = self._purge_expired_locked(self._load_state())
            candidate = next(
                (
                    item
                    for item in state["candidates"]
                    if item["candidateId"] == candidate_id
                ),
                None,
            )
            review = candidate.get("review") if candidate is not None else None
            if (
                candidate is None
                or candidate["status"] != "reviewed"
                or candidate["previewSha256"] != preview_sha256
                or not isinstance(review, dict)
                or review.get("tokenSha256") != token_sha256
                or _parse_timestamp(review.get("expiresAt"), "review expiresAt")
                <= _utc_now()
                or review.get("userActionId") == user_action_id
            ):
                raise security_error(
                    "PLUGIN_TRUST_CONFIRMATION_INVALID",
                    "the exact trust review token is invalid, expired, reused, or changed",
                )
            path = self._candidate_path(candidate_id)
            if path.is_symlink() or not path.is_file():
                raise security_error(
                    "PLUGIN_TRUST_CANDIDATE_INVALID",
                    "claimed candidate is not a safe regular file",
                )
            actual_sha256, _size = _hash_file(path)
            if actual_sha256 != candidate["bundleSha256"]:
                raise security_error(
                    "PLUGIN_TRUST_CANDIDATE_INVALID",
                    "claimed candidate digest changed",
                )
            replacement = {**candidate, "status": "claimed", "review": None}
            candidates = [
                replacement if item["candidateId"] == candidate_id else item
                for item in state["candidates"]
            ]
            self._write_state({**state, "candidates": candidates})
        self.audit_log.append(
            category="trust",
            action="install-confirm",
            outcome="confirmed",
            trace_id=f"management-{user_action_id}",
            plugin_id=candidate["pluginId"],
            data={
                "actor": review["actor"],
                "reason": review["reason"],
                "reviewUserActionId": review["userActionId"],
                "confirmationUserActionId": user_action_id,
                "candidateId": candidate_id,
                "previewSha256": preview_sha256,
                "confirmationStep": 2,
                "codeExecutionAuthorized": True,
            },
        )
        return ClaimedLocalInstall(
            candidate_id,
            path,
            candidate["bundleSha256"],
            preview_sha256,
            dict(candidate["preview"]),
            review["reason"],
            review["actor"],
            review["userActionId"],
            user_action_id,
        )

    def authorize_claimed_local_install(
        self, *, bundle: Any, claim: ClaimedLocalInstall, evidence: TrustEvidence
    ) -> dict[str, Any] | None:
        self._require_enabled()
        if bundle.sha256 != claim.bundle_sha256:
            raise security_error(
                "PLUGIN_TRUST_CANDIDATE_INVALID", "claimed bundle identity changed"
            )
        authorization = self.build_authorization(bundle, evidence, mode="trusted-local")
        expected = claim.preview.get("authorization")
        if not isinstance(expected, dict) or expected != authorization.to_wire():
            raise security_error(
                "PLUGIN_TRUST_BINDING_CHANGED",
                "publisher, signature root, runtime, or sandbox status changed after review",
                plugin_id=bundle.manifest.plugin.id,
            )
        with security_lock(self.lock_path):
            state = self._load_state()
            state, previous, decision = self._record_decision_locked(
                state,
                bundle=bundle,
                evidence=evidence,
                authorization=authorization,
                reason=claim.reason,
                actor=claim.actor,
                user_action_id=claim.confirmation_user_action_id,
                source="local-install-double-confirmation",
            )
        self.audit_log.append(
            category="trust",
            action="elevate",
            outcome="recorded",
            trace_id=f"management-{claim.confirmation_user_action_id}",
            plugin_id=bundle.manifest.plugin.id,
            data={
                "actor": claim.actor,
                "reason": claim.reason,
                "userActionId": claim.confirmation_user_action_id,
                "fromMode": previous["mode"] if previous is not None else None,
                "toMode": decision["mode"],
                "bundleSha256": bundle.sha256,
                "runtimeIdentity": authorization.runtime_identity,
                "authorizationIdentity": authorization.authorization_identity,
            },
        )
        return previous

    def restore_decision_after_failed_install(
        self,
        *,
        bundle: Any,
        previous: dict[str, Any] | None,
        claim: ClaimedLocalInstall,
        error_type: str,
    ) -> None:
        with security_lock(self.lock_path):
            state = self._load_state()
            decisions = [
                item
                for item in state["decisions"]
                if not (
                    item["pluginId"] == bundle.manifest.plugin.id
                    and item["bundleSha256"] == bundle.sha256
                )
            ]
            if previous is not None:
                decisions.append(previous)
                decisions.sort(
                    key=lambda item: (item["pluginId"], item["bundleSha256"])
                )
            candidates = []
            for item in state["candidates"]:
                if item["candidateId"] == claim.candidate_id:
                    candidates.append({**item, "status": "prepared", "review": None})
                else:
                    candidates.append(item)
            self._write_state(
                {**state, "decisions": decisions, "candidates": candidates}
            )
        self.audit_log.append(
            category="trust",
            action="install",
            outcome="failed-restored",
            trace_id=f"management-{claim.confirmation_user_action_id}",
            plugin_id=bundle.manifest.plugin.id,
            data={
                "actor": claim.actor,
                "reason": claim.reason,
                "candidateId": claim.candidate_id,
                "errorType": error_type,
                "previousDecisionRestored": previous is not None,
            },
        )

    def reset_claim_after_failed_confirmation(
        self, *, claim: ClaimedLocalInstall, error_type: str
    ) -> None:
        """Require a fresh first confirmation after a pre-authorization failure."""

        with security_lock(self.lock_path):
            state = self._load_state()
            candidates = [
                {**item, "status": "prepared", "review": None}
                if item["candidateId"] == claim.candidate_id
                else item
                for item in state["candidates"]
            ]
            self._write_state({**state, "candidates": candidates})
        self.audit_log.append(
            category="trust",
            action="install",
            outcome="confirmation-failed",
            trace_id=f"management-{claim.confirmation_user_action_id}",
            plugin_id=claim.preview.get("plugin", {}).get("id"),
            data={
                "actor": claim.actor,
                "reason": claim.reason,
                "candidateId": claim.candidate_id,
                "errorType": error_type,
                "freshReviewRequired": True,
            },
        )

    def finalize_local_install(
        self, *, claim: ClaimedLocalInstall, plugin_id: str
    ) -> None:
        with security_lock(self.lock_path):
            state = self._load_state()
            candidates = [
                item
                for item in state["candidates"]
                if item["candidateId"] != claim.candidate_id
            ]
            self._write_state({**state, "candidates": candidates})
            claim.path.unlink(missing_ok=True)
        self.audit_log.append(
            category="trust",
            action="install",
            outcome="completed",
            trace_id=f"management-{claim.confirmation_user_action_id}",
            plugin_id=plugin_id,
            data={
                "actor": claim.actor,
                "reason": claim.reason,
                "candidateId": claim.candidate_id,
                "previewSha256": claim.preview_sha256,
            },
        )

    def begin_trust_change(
        self,
        *,
        bundle: Any,
        target_mode: str,
        reason: str,
        acknowledgements: Sequence[str],
        permission_diff: Mapping[str, Any],
        actor: str,
        user_action_id: str,
    ) -> dict[str, Any]:
        self._require_enabled()
        user_action_id = _bounded_user_action_id(user_action_id)
        if target_mode not in _TRUST_DECISION_MODES:
            raise security_error(
                "PLUGIN_TRUST_MODE_INVALID", "target trust mode is invalid"
            )
        reason = _bounded_reason(reason)
        actor = _bounded_actor(actor)
        evidence = self.trust_evidence_resolver(bundle)
        if evidence.raw_trust_level != "verified-publisher":
            raise security_error(
                "PLUGIN_TRUST_CHANGE_DENIED",
                "only a signed Marketplace bundle can switch between sandboxed and trusted-local modes",
                plugin_id=bundle.manifest.plugin.id,
            )
        current = self._current_authorization(bundle)
        assert current is not None
        if current.mode == target_mode:
            raise security_error(
                "PLUGIN_TRUST_CHANGE_NOOP",
                "target trust mode already matches the effective mode",
                plugin_id=bundle.manifest.plugin.id,
            )
        target = self.build_authorization(bundle, evidence, mode=target_mode)
        risks = self._permission_risks(bundle)
        preview = {
            "schemaVersion": TRUST_PREVIEW_SCHEMA_VERSION,
            "action": "trust-change",
            "pluginId": bundle.manifest.plugin.id,
            "bundleSha256": bundle.sha256,
            "source": evidence.to_wire(),
            "from": current.to_wire(),
            "to": target.to_wire(),
            "permissionDiff": dict(permission_diff),
            "runtimeDiff": self._runtime_diff(current, target),
            "requests": risks,
            "requiredAcknowledgements": list(self._acknowledgements(target, risks)),
        }
        exact = self._exact_acknowledgements(preview, acknowledgements)
        preview_sha256 = canonical_sha256(preview)
        token = f"trust-change-{secrets.token_urlsafe(32)}"
        change_id = f"trust-change-{secrets.token_hex(16)}"
        created = _utc_now()
        change = {
            "changeId": change_id,
            "pluginId": bundle.manifest.plugin.id,
            "bundleSha256": bundle.sha256,
            "previewSha256": preview_sha256,
            "preview": preview,
            "reason": reason,
            "actor": actor,
            "reviewUserActionId": user_action_id,
            "tokenSha256": canonical_sha256(token),
            "createdAt": _timestamp(created),
            "expiresAt": _timestamp(created + self.review_ttl),
        }
        with security_lock(self.lock_path):
            state = self._purge_expired_locked(self._load_state())
            self._write_state({**state, "changes": [*state["changes"], change]})
        self.audit_log.append(
            category="trust",
            action="change-review",
            outcome="confirmed",
            trace_id=f"management-{user_action_id}",
            plugin_id=bundle.manifest.plugin.id,
            data={
                "actor": actor,
                "reason": reason,
                "userActionId": user_action_id,
                "fromMode": current.mode,
                "toMode": target.mode,
                "previewSha256": preview_sha256,
                "acknowledgements": list(exact),
                "confirmationStep": 1,
            },
        )
        return {
            "changeId": change_id,
            "previewSha256": preview_sha256,
            "confirmationToken": token,
            "expiresAt": change["expiresAt"],
            "preview": preview,
        }

    def confirm_trust_change(
        self,
        *,
        bundle: Any,
        change_id: str,
        preview_sha256: str,
        confirmation_token: str,
        user_action_id: str,
    ) -> dict[str, Any]:
        self._require_enabled()
        user_action_id = _bounded_user_action_id(user_action_id)
        with security_lock(self.lock_path):
            state = self._purge_expired_locked(self._load_state())
            change = next(
                (item for item in state["changes"] if item["changeId"] == change_id),
                None,
            )
            if (
                change is None
                or change["pluginId"] != bundle.manifest.plugin.id
                or change["bundleSha256"] != bundle.sha256
                or change["previewSha256"] != preview_sha256
                or change["tokenSha256"] != canonical_sha256(confirmation_token)
                or change["reviewUserActionId"] == user_action_id
            ):
                raise security_error(
                    "PLUGIN_TRUST_CONFIRMATION_INVALID",
                    "trust change confirmation is invalid",
                )
            evidence = self.trust_evidence_resolver(bundle)
            target_mode = change["preview"]["to"]["mode"]
            target = self.build_authorization(bundle, evidence, mode=target_mode)
            if target.to_wire() != change["preview"]["to"]:
                raise security_error(
                    "PLUGIN_TRUST_BINDING_CHANGED",
                    "trust change binding changed after review",
                )
            state, previous, decision = self._record_decision_locked(
                state,
                bundle=bundle,
                evidence=evidence,
                authorization=target,
                reason=change["reason"],
                actor=change["actor"],
                user_action_id=user_action_id,
                source="trust-change-double-confirmation",
                persist=False,
            )
            state = {
                **state,
                "changes": [
                    item for item in state["changes"] if item["changeId"] != change_id
                ],
            }
            self._write_state(state)
        self.audit_log.append(
            category="trust",
            action="elevate" if target.mode == "trusted-local" else "revoke",
            outcome="recorded",
            trace_id=f"management-{user_action_id}",
            plugin_id=bundle.manifest.plugin.id,
            data={
                "actor": change["actor"],
                "reason": change["reason"],
                "reviewUserActionId": change["reviewUserActionId"],
                "confirmationUserActionId": user_action_id,
                "fromMode": previous["mode"]
                if previous is not None
                else "marketplace-sandboxed",
                "toMode": decision["mode"],
                "runtimeIdentity": decision["runtimeIdentity"],
                "authorizationIdentity": decision["authorizationIdentity"],
                "confirmationStep": 2,
            },
        )
        return {
            "changed": previous != decision,
            "fromMode": previous["mode"]
            if previous is not None
            else "marketplace-sandboxed",
            "toMode": decision["mode"],
            "authorizationIdentity": decision["authorizationIdentity"],
        }

    def summary(self, bundle: Any) -> dict[str, Any]:
        evidence = self.trust_evidence_resolver(bundle)
        default_mode = canonical_trust_mode(evidence.raw_trust_level)
        with security_lock(self.lock_path):
            state = self._load_state()
            decision = self._decision_for(
                state, bundle.manifest.plugin.id, bundle.sha256
            )
        mode = decision["mode"] if decision is not None else default_mode
        if mode == "developer-local":
            mode = "trusted-local"
        authorization = self.build_authorization(bundle, evidence, mode=mode)
        return {
            "schemaVersion": "candlescope.plugin-trust-summary/1",
            "uxEnabled": self.enabled,
            "mode": mode,
            "defaultMode": default_mode,
            "decisionRecorded": decision is not None,
            "source": evidence.to_wire(),
            "authorization": authorization.to_wire(),
            "requests": self._permission_risks(bundle),
            "profiles": list(restricted_runtime_profiles_status()),
            "changeAllowed": evidence.raw_trust_level == "verified-publisher",
            "highRiskAuthorityIndependent": True,
        }
