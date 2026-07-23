"""Explicit, reversible catalog bridge for v1 script runtime installations.

The bridge never converts a v1 activation into a v2 activation.  It projects
the already validated v1 Indicator catalog into a compatibility contribution
and stores only bounded, public snapshots when the user explicitly imports the
v1 registry into the unified catalog.
"""

from __future__ import annotations

import copy
import hashlib
import re
import threading
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from candlescope_plugin_sdk.platform_v2 import canonical_dumps

from app.plugin_core_v2.errors import CorePluginError, core_error
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.storage import atomic_write_json, read_json, security_lock


COMPATIBILITY_CATALOG_SCHEMA_VERSION = "candlescope.v1-script-runtime-compatibility/1"
COMPATIBILITY_STATE_SCHEMA_VERSION = "candlescope.v1-compatibility-import-state/1"
COMPATIBILITY_PREVIEW_SCHEMA_VERSION = "candlescope.v1-compatibility-preview/1"
UNIFIED_CATALOG_SCHEMA_VERSION = "candlescope.unified-plugin-catalog/1"
COMPATIBILITY_CONTRIBUTION_KIND = "script-runtime/1"
V1_RUNTIME_PROTOCOL = "candlescope.script-runtime/1"
V1_RENDER_PROTOCOL = "candlescope.render/1"
MAX_COMPATIBILITY_SNAPSHOTS = 16
MAX_COMPATIBILITY_HISTORY = 8

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_V1_IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")


class IndicatorCatalogSource(Protocol):
    def compatibility_source_catalog(self) -> dict[str, Any]: ...


class RuntimeHostSource(Protocol):
    registry: Any
    host_name: str
    host_version: str
    enabled: bool


def _digest(value: Any) -> str:
    payload = canonical_dumps(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _exact_mapping(
    value: Any,
    *,
    required: set[str],
    optional: set[str] = frozenset(),
    label: str,
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) - required - optional:
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} has an invalid shape",
        )
    if required - set(value):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} is missing required fields",
        )
    return value


def _integer(value: Any, *, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} must be an integer greater than or equal to {minimum}",
        )
    return value


def _optional_revision(value: Any, *, label: str) -> int | None:
    if value is None:
        return None
    return _integer(value, label=label, minimum=1)


def _string(value: Any, *, label: str, maximum: int = 512) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or value != value.strip()
        or "\0" in value
    ):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} must be a bounded non-empty string",
        )
    return value


def _validate_contribution(value: Any, *, label: str) -> dict[str, Any]:
    item = _exact_mapping(
        value,
        required={
            "id",
            "kind",
            "runtimeId",
            "title",
            "version",
            "package",
            "available",
            "protocol",
            "renderProtocol",
            "languages",
            "features",
            "routeModes",
            "release",
        },
        label=label,
    )
    contribution_id = _string(item["id"], label=f"{label}.id", maximum=160)
    runtime_id = _string(item["runtimeId"], label=f"{label}.runtimeId", maximum=64)
    if (
        _V1_IDENTIFIER.fullmatch(runtime_id) is None
        or contribution_id != f"compat.v1.{runtime_id}"
        or item["kind"] != COMPATIBILITY_CONTRIBUTION_KIND
        or item["protocol"] != V1_RUNTIME_PROTOCOL
        or item["renderProtocol"] != V1_RENDER_PROTOCOL
        or not isinstance(item["available"], bool)
    ):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} contains an invalid compatibility identity",
        )
    languages = item["languages"]
    if not isinstance(languages, list) or not 1 <= len(languages) <= 64:
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label}.languages must be a bounded non-empty array",
        )
    parsed_languages: list[dict[str, Any]] = []
    for index, raw_language in enumerate(languages):
        language_label = f"{label}.languages[{index}]"
        language = _exact_mapping(
            raw_language,
            required={
                "id",
                "name",
                "extensions",
                "aliases",
                "routeMode",
                "available",
            },
            label=language_label,
        )
        if not isinstance(language["available"], bool):
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
                f"{language_label}.available must be boolean",
            )
        extensions = language["extensions"]
        aliases = language["aliases"]
        if (
            not isinstance(extensions, list)
            or len(extensions) > 32
            or not all(
                isinstance(entry, str) and 0 < len(entry) <= 32 for entry in extensions
            )
            or not isinstance(aliases, list)
            or len(aliases) > 32
            or not all(
                isinstance(entry, str) and 0 < len(entry) <= 64 for entry in aliases
            )
        ):
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
                f"{language_label} extensions or aliases are invalid",
            )
        parsed_languages.append(
            {
                "id": _string(language["id"], label=f"{language_label}.id", maximum=64),
                "name": _string(
                    language["name"], label=f"{language_label}.name", maximum=128
                ),
                "extensions": list(extensions),
                "aliases": list(aliases),
                "routeMode": _string(
                    language["routeMode"],
                    label=f"{language_label}.routeMode",
                    maximum=32,
                ),
                "available": language["available"],
            }
        )
        if _V1_IDENTIFIER.fullmatch(parsed_languages[-1]["id"]) is None:
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
                f"{language_label}.id is not a valid v1 identifier",
            )
    if len({item["id"] for item in parsed_languages}) != len(parsed_languages):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label}.languages contains duplicate ids",
        )
    features = item["features"]
    route_modes = item["routeModes"]
    if (
        not isinstance(features, list)
        or len(features) > 64
        or not all(
            isinstance(entry, str) and 0 < len(entry) <= 128 for entry in features
        )
        or len(set(features)) != len(features)
        or not isinstance(route_modes, list)
        or not 1 <= len(route_modes) <= 3
        or not all(
            isinstance(entry, str) and entry in {"legacy", "shadow", "sidecar"}
            for entry in route_modes
        )
        or len(set(route_modes)) != len(route_modes)
    ):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} features or route modes are invalid",
        )
    release = _exact_mapping(
        item["release"],
        required={"managed"},
        optional={"bundleSha256"},
        label=f"{label}.release",
    )
    if not isinstance(release["managed"], bool):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label}.release.managed must be boolean",
        )
    bundle_sha256 = release.get("bundleSha256")
    if bundle_sha256 is not None and (
        not release["managed"]
        or not isinstance(bundle_sha256, str)
        or _SHA256.fullmatch(bundle_sha256) is None
    ):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label}.release.bundleSha256 is invalid",
        )
    return {
        "id": contribution_id,
        "kind": COMPATIBILITY_CONTRIBUTION_KIND,
        "runtimeId": runtime_id,
        "title": _string(item["title"], label=f"{label}.title", maximum=128),
        "version": _string(item["version"], label=f"{label}.version", maximum=128),
        "package": _string(item["package"], label=f"{label}.package", maximum=128),
        "available": item["available"],
        "protocol": V1_RUNTIME_PROTOCOL,
        "renderProtocol": V1_RENDER_PROTOCOL,
        "languages": parsed_languages,
        "features": list(features),
        "routeModes": list(route_modes),
        "release": {
            "managed": release["managed"],
            **({"bundleSha256": bundle_sha256} if bundle_sha256 is not None else {}),
        },
    }


def _validate_snapshot(value: Any, *, label: str) -> dict[str, Any]:
    snapshot = _exact_mapping(
        value,
        required={
            "snapshotRevision",
            "sourceSha256",
            "importedAt",
            "contributions",
        },
        label=label,
    )
    source_sha256 = _string(
        snapshot["sourceSha256"], label=f"{label}.sourceSha256", maximum=71
    )
    imported_at = _string(
        snapshot["importedAt"], label=f"{label}.importedAt", maximum=64
    )
    try:
        parsed_imported_at = datetime.fromisoformat(
            imported_at[:-1] + "+00:00" if imported_at.endswith("Z") else imported_at
        )
    except ValueError:
        parsed_imported_at = None
    if (
        _SHA256.fullmatch(source_sha256) is None
        or parsed_imported_at is None
        or parsed_imported_at.tzinfo != UTC
    ):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label} digest or timestamp is invalid",
        )
    raw_contributions = snapshot["contributions"]
    if not isinstance(raw_contributions, list) or len(raw_contributions) > 128:
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label}.contributions must be a bounded array",
        )
    contributions = [
        _validate_contribution(item, label=f"{label}.contributions[{index}]")
        for index, item in enumerate(raw_contributions)
    ]
    if len({item["id"] for item in contributions}) != len(contributions):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            f"{label}.contributions contains duplicate ids",
        )
    return {
        "snapshotRevision": _integer(
            snapshot["snapshotRevision"],
            label=f"{label}.snapshotRevision",
            minimum=1,
        ),
        "sourceSha256": source_sha256,
        "importedAt": imported_at,
        "contributions": contributions,
    }


def _empty_state() -> dict[str, Any]:
    return {
        "schemaVersion": COMPATIBILITY_STATE_SCHEMA_VERSION,
        "revision": 0,
        "activeSnapshotRevision": None,
        "history": [],
        "snapshots": [],
    }


def _invalid_public_catalog() -> dict[str, Any]:
    return {
        "schemaVersion": COMPATIBILITY_CATALOG_SCHEMA_VERSION,
        "status": "invalid",
        "kind": COMPATIBILITY_CONTRIBUTION_KIND,
        "protocol": V1_RUNTIME_PROTOCOL,
        "renderProtocol": V1_RENDER_PROTOCOL,
        "import": {
            "status": "invalid",
            "stateRevision": 0,
            "activeSnapshotRevision": None,
            "sourceSha256": None,
            "importedSourceSha256": None,
            "historyDepth": 0,
            "rollbackAvailable": False,
        },
        "contributions": [],
    }


def _validate_state(value: Any) -> dict[str, Any]:
    state = _exact_mapping(
        value,
        required={
            "schemaVersion",
            "revision",
            "activeSnapshotRevision",
            "history",
            "snapshots",
        },
        label="v1 compatibility import state",
    )
    if state["schemaVersion"] != COMPATIBILITY_STATE_SCHEMA_VERSION:
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            "v1 compatibility import state schema is unsupported",
        )
    revision = _integer(state["revision"], label="state.revision")
    active = _optional_revision(
        state["activeSnapshotRevision"], label="state.activeSnapshotRevision"
    )
    history = state["history"]
    snapshots = state["snapshots"]
    if (
        not isinstance(history, list)
        or len(history) > MAX_COMPATIBILITY_HISTORY
        or not isinstance(snapshots, list)
        or len(snapshots) > MAX_COMPATIBILITY_SNAPSHOTS
    ):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            "v1 compatibility import history exceeds its bound",
        )
    parsed_history = [
        _optional_revision(item, label=f"state.history[{index}]")
        for index, item in enumerate(history)
    ]
    parsed_snapshots = [
        _validate_snapshot(item, label=f"state.snapshots[{index}]")
        for index, item in enumerate(snapshots)
    ]
    snapshot_ids = [item["snapshotRevision"] for item in parsed_snapshots]
    if len(snapshot_ids) != len(set(snapshot_ids)):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            "v1 compatibility snapshots contain duplicate revisions",
        )
    known = set(snapshot_ids)
    referenced = {item for item in [active, *parsed_history] if item is not None}
    if not referenced <= known or any(item > revision for item in known):
        raise core_error(
            "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
            "v1 compatibility state references an unknown snapshot",
        )
    return {
        "schemaVersion": COMPATIBILITY_STATE_SCHEMA_VERSION,
        "revision": revision,
        "activeSnapshotRevision": active,
        "history": parsed_history,
        "snapshots": parsed_snapshots,
    }


def _snapshot_by_revision(
    state: Mapping[str, Any], revision: int | None
) -> dict[str, Any] | None:
    if revision is None:
        return None
    return next(
        (
            snapshot
            for snapshot in state["snapshots"]
            if snapshot["snapshotRevision"] == revision
        ),
        None,
    )


def _change_set(
    before: list[dict[str, Any]], after: list[dict[str, Any]]
) -> list[dict[str, str]]:
    old = {item["id"]: item for item in before}
    new = {item["id"]: item for item in after}
    changes: list[dict[str, str]] = []
    for contribution_id in sorted(set(old) | set(new)):
        if contribution_id not in old:
            action = "add"
        elif contribution_id not in new:
            action = "remove"
        elif canonical_dumps(old[contribution_id]) != canonical_dumps(
            new[contribution_id]
        ):
            action = "update"
        else:
            continue
        changes.append({"id": contribution_id, "action": action})
    return changes


class V1ScriptRuntimeCompatibilityBridge:
    """Build a safe compatibility contribution and own explicit import history."""

    def __init__(
        self,
        *,
        root: Path | str,
        indicator_source: IndicatorCatalogSource,
        runtime_host: RuntimeHostSource,
        clock: Callable[[], str] = _utc_now,
    ) -> None:
        self.root = Path(root).expanduser().resolve(strict=False)
        self.state_path = self.root / "v1-compatibility-import-v1.json"
        self.lock_path = self.root / "v1-compatibility-import-v1.lock"
        self.indicator_source = indicator_source
        self.runtime_host = runtime_host
        self._clock = clock
        self._thread_lock = threading.RLock()

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists() and not self.state_path.is_symlink():
            return _empty_state()
        if self.state_path.is_symlink():
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
                "v1 compatibility import state must not be a symlink",
            )
        try:
            return _validate_state(
                read_json(self.state_path, "v1 compatibility import state")
            )
        except PlatformSecurityError as exc:
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_STATE_INVALID",
                "v1 compatibility import state is unavailable",
                details={"cause": exc.code},
            ) from exc

    def _source_identity(self, v1_catalog: Mapping[str, Any]) -> dict[str, Any]:
        registry_entries: list[dict[str, Any]] = []
        for spec in self.runtime_host.registry.plugins:
            registry_entries.append(
                {
                    "runtimeId": spec.runtime_id,
                    "package": spec.expected_package,
                    "version": spec.expected_version,
                    "enabled": spec.enabled,
                    "autoStart": spec.auto_start,
                    "required": spec.required,
                    "managed": (
                        spec.managed.to_wire() if spec.managed is not None else None
                    ),
                }
            )
        return {
            "protocol": V1_RUNTIME_PROTOCOL,
            "renderProtocol": V1_RENDER_PROTOCOL,
            "host": {
                "name": self.runtime_host.host_name,
                "version": self.runtime_host.host_version,
                "enabled": self.runtime_host.enabled,
            },
            "registry": registry_entries,
            "indicatorCatalog": copy.deepcopy(dict(v1_catalog)),
        }

    def _contributions(self, v1_catalog: Mapping[str, Any]) -> list[dict[str, Any]]:
        runtimes = {
            item["id"]: item
            for item in v1_catalog.get("runtimes", [])
            if isinstance(item, Mapping) and isinstance(item.get("id"), str)
        }
        languages_by_runtime: dict[str, list[dict[str, Any]]] = {}
        for raw_language in v1_catalog.get("languages", []):
            if not isinstance(raw_language, Mapping):
                continue
            runtime_id = raw_language.get("runtimeId")
            key = (
                runtime_id
                if isinstance(runtime_id, str)
                else f"legacy.{raw_language.get('id', 'unknown')}"
            )
            language = {
                "id": raw_language.get("id"),
                "name": raw_language.get("name"),
                "extensions": list(raw_language.get("extensions", [])),
                "aliases": list(raw_language.get("aliases", [])),
                "routeMode": raw_language.get("routeMode"),
                "available": raw_language.get("available"),
            }
            languages_by_runtime.setdefault(key, []).append(language)

        registry_by_id = self.runtime_host.registry.by_id()
        contributions: list[dict[str, Any]] = []
        for runtime_id in sorted(languages_by_runtime):
            runtime = runtimes.get(runtime_id)
            spec = registry_by_id.get(runtime_id)
            languages = languages_by_runtime[runtime_id]
            features = list(runtime.get("features", [])) if runtime is not None else []
            title = (
                runtime.get("name")
                if runtime is not None
                else f"{languages[0].get('name', runtime_id)} legacy adapter"
            )
            version = (
                runtime.get("version")
                if runtime is not None
                else self.runtime_host.host_version
            )
            package = (
                runtime.get("package") if runtime is not None else "candlescope.host"
            )
            release = {
                "managed": bool(spec is not None and spec.managed is not None),
                **(
                    {"bundleSha256": spec.managed.bundle_sha256}
                    if spec is not None and spec.managed is not None
                    else {}
                ),
            }
            contribution = {
                "id": f"compat.v1.{runtime_id}",
                "kind": COMPATIBILITY_CONTRIBUTION_KIND,
                "runtimeId": runtime_id,
                "title": title,
                "version": version,
                "package": package,
                "available": all(item.get("available") is True for item in languages),
                "protocol": V1_RUNTIME_PROTOCOL,
                "renderProtocol": V1_RENDER_PROTOCOL,
                "languages": languages,
                "features": features,
                "routeModes": sorted(
                    {str(item.get("routeMode")) for item in languages}
                ),
                "release": release,
            }
            contributions.append(
                _validate_contribution(
                    contribution,
                    label=f"live compatibility contribution {runtime_id!r}",
                )
            )
        return contributions

    def _source_snapshot(
        self, v1_catalog: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        catalog = (
            self.indicator_source.compatibility_source_catalog()
            if v1_catalog is None
            else copy.deepcopy(dict(v1_catalog))
        )
        if (
            set(catalog)
            != {"schemaVersion", "defaultLanguage", "languages", "runtimes"}
            or catalog["schemaVersion"] != 1
            or not isinstance(catalog["languages"], list)
            or not isinstance(catalog["runtimes"], list)
        ):
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_SOURCE_INVALID",
                "the v1 Indicator catalog cannot be projected safely",
            )
        contributions = self._contributions(catalog)
        identity = self._source_identity(catalog)
        return {
            "sourceSha256": _digest(identity),
            "v1IndicatorCatalog": catalog,
            "contributions": contributions,
        }

    @staticmethod
    def _state_summary(
        state: Mapping[str, Any],
        source: Mapping[str, Any],
        *,
        invalid: bool = False,
    ) -> dict[str, Any]:
        active = _snapshot_by_revision(state, state["activeSnapshotRevision"])
        if invalid:
            status = "invalid"
        elif active is None:
            status = "not-imported"
        elif active["sourceSha256"] == source["sourceSha256"]:
            status = "current"
        else:
            status = "stale"
        return {
            "status": status,
            "stateRevision": state["revision"],
            "activeSnapshotRevision": state["activeSnapshotRevision"],
            "sourceSha256": source["sourceSha256"],
            "importedSourceSha256": (
                active["sourceSha256"] if active is not None else None
            ),
            "historyDepth": len(state["history"]),
            "rollbackAvailable": bool(state["history"]),
        }

    def unified_catalog(
        self, v1_catalog: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        source = self._source_snapshot(v1_catalog)
        invalid = False
        try:
            state = self._load_state()
        except Exception:
            state = _empty_state()
            invalid = True
        summary = self._state_summary(state, source, invalid=invalid)
        imported = summary["status"] == "current"
        return {
            "schemaVersion": UNIFIED_CATALOG_SCHEMA_VERSION,
            "compatibility": {
                "schemaVersion": COMPATIBILITY_CATALOG_SCHEMA_VERSION,
                "status": "invalid" if invalid else "ready",
                "kind": COMPATIBILITY_CONTRIBUTION_KIND,
                "protocol": V1_RUNTIME_PROTOCOL,
                "renderProtocol": V1_RENDER_PROTOCOL,
                "import": summary,
                "contributions": [
                    {**copy.deepcopy(item), "imported": imported}
                    for item in source["contributions"]
                ],
            },
            "v1IndicatorCatalog": copy.deepcopy(source["v1IndicatorCatalog"]),
        }

    def public_catalog(self) -> dict[str, Any]:
        try:
            return self.unified_catalog()["compatibility"]
        except CorePluginError:
            return _invalid_public_catalog()

    def project_indicator_catalog(
        self, v1_catalog: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Round-trip the frozen v1 wire without inheriting compatibility failure."""

        try:
            return self.unified_catalog(v1_catalog)["v1IndicatorCatalog"]
        except CorePluginError:
            return copy.deepcopy(dict(v1_catalog))

    def _preview(
        self,
        *,
        action: str,
        state: Mapping[str, Any],
        source: Mapping[str, Any],
    ) -> dict[str, Any]:
        active = _snapshot_by_revision(state, state["activeSnapshotRevision"])
        before = active["contributions"] if active is not None else []
        target_revision: int | None = None
        available = True
        if action == "import":
            after = source["contributions"]
        elif action == "rollback":
            available = bool(state["history"])
            target_revision = state["history"][-1] if available else None
            target = (
                _snapshot_by_revision(state, target_revision) if available else active
            )
            after = target["contributions"] if target is not None else []
        else:
            raise ValueError("unsupported v1 compatibility preview action")
        body = {
            "schemaVersion": COMPATIBILITY_PREVIEW_SCHEMA_VERSION,
            "action": action,
            "available": available,
            "stateRevision": state["revision"],
            "sourceSha256": source["sourceSha256"],
            "targetSnapshotRevision": target_revision,
            "changes": _change_set(before, after),
        }
        return {
            **body,
            "previewSha256": _digest(body) if available else None,
        }

    def import_preview(self) -> dict[str, Any]:
        with self._thread_lock:
            state = self._load_state()
            source = self._source_snapshot()
            return self._preview(action="import", state=state, source=source)

    def rollback_preview(self) -> dict[str, Any]:
        with self._thread_lock:
            state = self._load_state()
            source = self._source_snapshot()
            return self._preview(action="rollback", state=state, source=source)

    @staticmethod
    def _require_preview_digest(value: Any) -> str:
        if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
            raise core_error(
                "PLUGIN_V1_COMPATIBILITY_PREVIEW_REQUIRED",
                "an exact compatibility preview SHA-256 is required",
            )
        return value

    def apply_import(self, preview_sha256: str) -> dict[str, Any]:
        expected = self._require_preview_digest(preview_sha256)
        with self._thread_lock, security_lock(self.lock_path):
            state = self._load_state()
            source = self._source_snapshot()
            preview = self._preview(action="import", state=state, source=source)
            if preview["previewSha256"] != expected:
                raise core_error(
                    "PLUGIN_V1_COMPATIBILITY_PREVIEW_STALE",
                    "the v1 compatibility import preview is stale",
                )
            active = _snapshot_by_revision(state, state["activeSnapshotRevision"])
            if active is not None and active["sourceSha256"] == source["sourceSha256"]:
                return {
                    "changed": False,
                    "compatibility": self.unified_catalog()["compatibility"],
                }
            next_revision = state["revision"] + 1
            snapshot = {
                "snapshotRevision": next_revision,
                "sourceSha256": source["sourceSha256"],
                "importedAt": self._clock(),
                "contributions": copy.deepcopy(source["contributions"]),
            }
            history = [
                *state["history"],
                state["activeSnapshotRevision"],
            ][-MAX_COMPATIBILITY_HISTORY:]
            referenced = {item for item in history if item is not None} | {
                next_revision
            }
            snapshots = [
                item
                for item in state["snapshots"]
                if item["snapshotRevision"] in referenced
            ]
            snapshots.append(snapshot)
            updated = _validate_state(
                {
                    "schemaVersion": COMPATIBILITY_STATE_SCHEMA_VERSION,
                    "revision": next_revision,
                    "activeSnapshotRevision": next_revision,
                    "history": history,
                    "snapshots": snapshots[-MAX_COMPATIBILITY_SNAPSHOTS:],
                }
            )
            atomic_write_json(self.state_path, updated)
            return {
                "changed": True,
                "compatibility": self.unified_catalog()["compatibility"],
            }

    def apply_rollback(self, preview_sha256: str) -> dict[str, Any]:
        expected = self._require_preview_digest(preview_sha256)
        with self._thread_lock, security_lock(self.lock_path):
            state = self._load_state()
            source = self._source_snapshot()
            preview = self._preview(action="rollback", state=state, source=source)
            if not preview["available"]:
                raise core_error(
                    "PLUGIN_V1_COMPATIBILITY_ROLLBACK_UNAVAILABLE",
                    "no prior v1 compatibility import snapshot is available",
                )
            if preview["previewSha256"] != expected:
                raise core_error(
                    "PLUGIN_V1_COMPATIBILITY_PREVIEW_STALE",
                    "the v1 compatibility rollback preview is stale",
                )
            target = state["history"][-1]
            next_revision = state["revision"] + 1
            history = [
                *state["history"][:-1],
                state["activeSnapshotRevision"],
            ][-MAX_COMPATIBILITY_HISTORY:]
            updated = _validate_state(
                {
                    **state,
                    "revision": next_revision,
                    "activeSnapshotRevision": target,
                    "history": history,
                }
            )
            atomic_write_json(self.state_path, updated)
            return {
                "changed": True,
                "compatibility": self.unified_catalog()["compatibility"],
            }
