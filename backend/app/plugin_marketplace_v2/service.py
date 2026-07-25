"""Verified index cache, artifact staging, updates, and revocation policy."""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import os
import re
import socket
import ssl
import tempfile
import uuid
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    loads_strict,
)

from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_installer_v2.bundle import (
    MAX_BUNDLE_BYTES,
    SBOM_PATH,
    VerifiedPlatformBundle,
    verify_platform_bundle,
)
from app.plugin_installer_v2.registry import load_activation_registry
from app.plugin_security_v2.grants import manifest_publisher_identity
from app.plugin_security_v2.storage import atomic_write_json, security_lock

from .errors import MarketplaceError
from .models import (
    MAX_INDEX_BYTES,
    MarketplaceRoot,
    PublisherRecord,
    ReleaseRecord,
    VerifiedMarketplaceIndex,
    verify_marketplace_index,
)


STATE_SCHEMA_VERSION = 1
CATALOG_SCHEMA_VERSION = "candlescope.marketplace-catalog/1"
STATUS_SCHEMA_VERSION = "candlescope.marketplace-status/1"
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_REMOTE_ARTIFACT_BYTES = min(MAX_BUNDLE_BYTES, 128 * 1024 * 1024)
DOWNLOAD_TIMEOUT_SECONDS = 30.0

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_STATE_LIMITS = JsonLimits(
    max_message_bytes=MAX_STATE_BYTES,
    max_depth=32,
    max_container_items=100_000,
    max_string_bytes=2 * 1024 * 1024,
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return f"sha256:{digest.hexdigest()}", size


def _major(value: str) -> int:
    try:
        major = int(value.split(".", 1)[0])
    except (ValueError, IndexError) as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_VERSION_INVALID",
            "plugin version has no valid SemVer major",
        ) from exc
    return major


def _version_key(
    value: str,
) -> tuple[int, int, int, int, tuple[tuple[int, int | str], ...]]:
    precedence = value.partition("+")[0]
    core, separator, prerelease = precedence.partition("-")
    parts = core.split(".")
    if len(parts) != 3:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_VERSION_INVALID",
            "marketplace release version is invalid",
        )
    try:
        numbers = tuple(int(item) for item in parts)
    except ValueError as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_VERSION_INVALID",
            "marketplace release version is invalid",
        ) from exc
    prerelease_key = tuple(
        (0, int(item)) if item.isdigit() else (1, item)
        for item in prerelease.split(".")
        if item
    )
    return (
        numbers[0],
        numbers[1],
        numbers[2],
        0 if separator else 1,
        prerelease_key,
    )


def _strict_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schemaVersion": STATE_SCHEMA_VERSION,
            "revision": 0,
            "indexes": [],
            "localBundles": [],
            "candidates": [],
        }
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_STATE_BYTES:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            "marketplace state must be a bounded regular file",
        )
    try:
        value = loads_strict(path.read_bytes(), limits=_STATE_LIMITS)
    except (OSError, PlatformContractError) as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            "marketplace state is not strict JSON",
        ) from exc
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schemaVersion",
            "revision",
            "indexes",
            "localBundles",
            "candidates",
        }
        or value.get("schemaVersion") != STATE_SCHEMA_VERSION
        or isinstance(value.get("revision"), bool)
        or not isinstance(value.get("revision"), int)
        or value["revision"] < 0
        or not all(
            isinstance(value.get(key), list)
            for key in ("indexes", "localBundles", "candidates")
        )
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            "marketplace state schema is invalid",
        )
    return value


def _state_string(value: Any, label: str, *, maximum: int = 2048) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\x00" in value
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            f"{label} is invalid",
        )
    return value


def _validate_state(state: dict[str, Any]) -> None:
    indexes: list[tuple[str, int]] = []
    for index, raw in enumerate(state["indexes"]):
        label = f"marketplace state.indexes[{index}]"
        if not isinstance(raw, dict) or set(raw) != {
            "marketplaceId",
            "sequence",
            "indexSha256",
            "cacheFile",
            "importedAt",
        }:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label} schema is invalid",
            )
        marketplace_id = _state_string(
            raw["marketplaceId"], f"{label}.marketplaceId", maximum=128
        )
        if _ID.fullmatch(marketplace_id) is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label}.marketplaceId is invalid",
            )
        sequence = raw["sequence"]
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label}.sequence is invalid",
            )
        if (
            not isinstance(raw["indexSha256"], str)
            or _SHA256.fullmatch(raw["indexSha256"]) is None
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label}.indexSha256 is invalid",
            )
        cache_file = _state_string(raw["cacheFile"], f"{label}.cacheFile", maximum=128)
        if cache_file != f"{raw['indexSha256'].removeprefix('sha256:')}.json":
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label}.cacheFile is not content-addressed",
            )
        _state_string(raw["importedAt"], f"{label}.importedAt", maximum=64)
        indexes.append((marketplace_id, sequence))
    if indexes != sorted(indexes) or len({item[0] for item in indexes}) != len(indexes):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            "marketplace state indexes must be ID-sorted and unique",
        )
    local_keys: list[str] = []
    for index, raw in enumerate(state["localBundles"]):
        label = f"marketplace state.localBundles[{index}]"
        if not isinstance(raw, dict) or set(raw) != {
            "bundleSha256",
            "pluginId",
            "version",
            "publisher",
            "recordedAt",
        }:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label} schema is invalid",
            )
        digest = _state_string(raw["bundleSha256"], f"{label}.bundleSha256", maximum=71)
        if _SHA256.fullmatch(digest) is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label}.bundleSha256 is invalid",
            )
        for key, maximum in (
            ("pluginId", 128),
            ("version", 64),
            ("publisher", 128),
            ("recordedAt", 64),
        ):
            _state_string(raw[key], f"{label}.{key}", maximum=maximum)
        local_keys.append(digest)
    if local_keys != sorted(local_keys) or len(set(local_keys)) != len(local_keys):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            "local bundle evidence must be digest-sorted and unique",
        )
    candidate_keys: list[str] = []
    candidate_fields = {
        "pluginId",
        "version",
        "marketplaceId",
        "publisherId",
        "bundleSha256",
        "artifactFile",
        "phase",
        "preparedAt",
        "fromVersion",
        "permissionDiff",
        "compatibility",
        "migration",
        "observation",
    }
    for index, raw in enumerate(state["candidates"]):
        label = f"marketplace state.candidates[{index}]"
        if not isinstance(raw, dict) or set(raw) != candidate_fields:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label} schema is invalid",
            )
        plugin_id = _state_string(raw["pluginId"], f"{label}.pluginId", maximum=128)
        for key, maximum in (
            ("version", 64),
            ("marketplaceId", 128),
            ("publisherId", 128),
            ("bundleSha256", 71),
            ("artifactFile", 128),
            ("phase", 32),
            ("preparedAt", 64),
        ):
            _state_string(raw[key], f"{label}.{key}", maximum=maximum)
        if raw["fromVersion"] is not None:
            _state_string(raw["fromVersion"], f"{label}.fromVersion", maximum=64)
        if (
            _SHA256.fullmatch(raw["bundleSha256"]) is None
            or raw["artifactFile"]
            != f"{raw['bundleSha256'].removeprefix('sha256:')}.cspkg"
            or raw["phase"]
            not in {
                "verified-staged",
                "activation-staged",
                "observing",
                "active",
                "rolled-back",
                "failed",
            }
            or not isinstance(raw["permissionDiff"], dict)
            or not isinstance(raw["compatibility"], dict)
            or not isinstance(raw["migration"], dict)
            or not isinstance(raw["observation"], dict)
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_STATE_INVALID",
                f"{label} values are invalid",
            )
        candidate_keys.append(plugin_id)
    if candidate_keys != sorted(candidate_keys) or len(set(candidate_keys)) != len(
        candidate_keys
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_STATE_INVALID",
            "marketplace candidates must be plugin-ID-sorted and unique",
        )


def _write_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_CACHE_UNSAFE",
            "marketplace cache directory must not be a symlink",
        )
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.part"
    try:
        with temporary.open("xb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            if path.is_symlink() or not path.is_file() or path.read_bytes() != value:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_IMMUTABILITY_VIOLATION",
                    "content-addressed marketplace cache entry changed",
                )
            temporary.unlink()
            return
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class MarketplaceFetcher(Protocol):
    def get(self, url: str, *, maximum: int) -> bytes: ...


class PinnedMarketplaceFetcher:
    """Pinned-DNS HTTPS-only fetcher with no redirects or ambient proxy."""

    def __init__(
        self,
        *,
        resolver: Callable[[str, int], tuple[str, ...]] | None = None,
        timeout_seconds: float = DOWNLOAD_TIMEOUT_SECONDS,
    ) -> None:
        self.resolver = resolver or self._resolve_public_addresses
        self.timeout_seconds = timeout_seconds

    @staticmethod
    def _resolve_public_addresses(host: str, port: int) -> tuple[str, ...]:
        try:
            values = socket.getaddrinfo(
                host,
                port,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            )
        except OSError as exc:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                "marketplace hostname resolution failed",
            ) from exc
        addresses = sorted({item[4][0].split("%", 1)[0] for item in values})
        if not addresses:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                "marketplace hostname resolved to no address",
            )
        for value in addresses:
            try:
                address = ipaddress.ip_address(value)
            except ValueError as exc:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                    "marketplace hostname resolved to an invalid address",
                ) from exc
            if not address.is_global:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_PRIVATE_ADDRESS_DENIED",
                    "marketplace hostname resolved to a non-public address",
                )
        return tuple(addresses)

    class _PinnedConnection(http.client.HTTPSConnection):
        def __init__(
            self,
            host: str,
            *,
            resolved_ip: str,
            timeout: float,
        ) -> None:
            super().__init__(
                host,
                443,
                timeout=timeout,
                context=ssl.create_default_context(),
            )
            self._resolved_ip = resolved_ip

        def connect(self) -> None:
            raw = socket.create_connection(
                (self._resolved_ip, self.port),
                self.timeout,
            )
            try:
                self.sock = self._context.wrap_socket(
                    raw,
                    server_hostname=self.host,
                )
            except BaseException:
                raw.close()
                raise

    def get(self, url: str, *, maximum: int) -> bytes:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.port not in {None, 443}
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_URL_INVALID",
                "marketplace fetch URL is not canonical HTTPS",
            )
        host = parsed.hostname.lower()
        addresses = self.resolver(host, 443)
        if not addresses:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                "marketplace hostname resolved to no public address",
            )
        for value in addresses:
            try:
                address = ipaddress.ip_address(value.split("%", 1)[0])
            except ValueError as exc:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                    "marketplace resolver returned an invalid address",
                ) from exc
            if not address.is_global:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_PRIVATE_ADDRESS_DENIED",
                    "marketplace resolver returned a non-public address",
                )
        connection = self._PinnedConnection(
            host,
            resolved_ip=addresses[0].split("%", 1)[0],
            timeout=self.timeout_seconds,
        )
        try:
            connection.request(
                "GET",
                parsed.path or "/",
                headers={
                    "Accept": "application/json, application/octet-stream",
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                    "User-Agent": "CandleScope-Marketplace/1",
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                    "marketplace server returned a non-success response",
                    details={"status": response.status},
                )
            encoding = response.getheader("content-encoding")
            if encoding is not None and encoding.strip().lower() not in {
                "",
                "identity",
            }:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_CONTENT_ENCODING_DENIED",
                    "compressed marketplace responses are not accepted",
                )
            content_length = response.getheader("content-length")
            if content_length is not None:
                try:
                    declared = int(content_length)
                except ValueError as exc:
                    raise MarketplaceError(
                        "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                        "marketplace Content-Length is invalid",
                    ) from exc
                if declared < 0 or declared > maximum:
                    raise MarketplaceError(
                        "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
                        "marketplace response exceeds its byte limit",
                    )
            body = response.read(maximum + 1)
            if len(body) > maximum:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
                    "marketplace response exceeds its byte limit",
                )
            return body
        except MarketplaceError:
            raise
        except (OSError, http.client.HTTPException, ssl.SSLError) as exc:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_NETWORK_FAILED",
                "marketplace HTTPS request failed",
            ) from exc
        finally:
            connection.close()


@dataclass(frozen=True, slots=True)
class BundleTrust:
    trust_level: str
    publisher_identity: str
    source: str
    marketplace_id: str | None
    release: ReleaseRecord | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "trustLevel": self.trust_level,
            "publisherIdentity": self.publisher_identity,
            "source": self.source,
            "marketplaceId": self.marketplace_id,
            "releaseSha256": (
                self.release.artifact.sha256 if self.release is not None else None
            ),
        }


class PluginMarketplaceService:
    """Own signed metadata and updates without owning grants or activation policy."""

    def __init__(
        self,
        *,
        root: Path | str,
        installer: PlatformPluginInstaller,
        roots: tuple[MarketplaceRoot, ...] = (),
        enabled: bool = False,
        fetcher: MarketplaceFetcher | None = None,
    ) -> None:
        self.root = Path(root).expanduser().resolve(strict=False)
        self.installer = installer
        self.roots = {item.marketplace_id: item for item in roots}
        self.enabled = enabled
        self.fetcher = fetcher or PinnedMarketplaceFetcher()
        self.state_path = self.root / "marketplace-state-v1.json"
        self.lock_path = self.root / "marketplace-v1.lock"
        self.index_directory = self.root / "marketplace-v1" / "indexes"
        self.artifact_directory = self.root / "marketplace-v1" / "artifacts"
        self._indexes: dict[str, VerifiedMarketplaceIndex] = {}
        self._known_indexes: dict[str, VerifiedMarketplaceIndex] = {}
        self._cache_errors: dict[str, str] = {}
        if enabled and not any(item.enabled for item in roots):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ROOT_REQUIRED",
                "enabling Marketplace requires at least one build-pinned root",
            )
        self.reload_cache()

    def _state(self) -> dict[str, Any]:
        state = _strict_state(self.state_path)
        _validate_state(state)
        return state

    def _commit_state(self, state: dict[str, Any]) -> None:
        state["revision"] += 1
        state["indexes"] = sorted(
            state["indexes"], key=lambda item: item["marketplaceId"]
        )
        state["localBundles"] = sorted(
            state["localBundles"], key=lambda item: item["bundleSha256"]
        )
        state["candidates"] = sorted(
            state["candidates"], key=lambda item: item["pluginId"]
        )
        _validate_state(state)
        atomic_write_json(self.state_path, state)

    def reload_cache(self) -> None:
        indexes: dict[str, VerifiedMarketplaceIndex] = {}
        known_indexes: dict[str, VerifiedMarketplaceIndex] = {}
        cache_errors: dict[str, str] = {}
        try:
            state = self._state()
            for item in state["indexes"]:
                marketplace_id = item["marketplaceId"]
                root = self.roots.get(marketplace_id)
                if root is None or not root.enabled:
                    cache_errors[marketplace_id] = "ROOT_UNAVAILABLE"
                    continue
                path = self.index_directory / marketplace_id / item["cacheFile"]
                try:
                    if path.is_symlink() or not path.is_file():
                        raise MarketplaceError(
                            "PLUGIN_MARKETPLACE_CACHE_INVALID",
                            "cached marketplace index is missing",
                        )
                    data = path.read_bytes()
                    if _sha256_bytes(data) != item["indexSha256"]:
                        raise MarketplaceError(
                            "PLUGIN_MARKETPLACE_CACHE_INVALID",
                            "cached marketplace index digest mismatch",
                        )
                    known = verify_marketplace_index(
                        data,
                        root=root,
                        allow_expired=True,
                    )
                    if (
                        known.sequence != item["sequence"]
                        or known.index_sha256 != item["indexSha256"]
                    ):
                        raise MarketplaceError(
                            "PLUGIN_MARKETPLACE_CACHE_INVALID",
                            "cached marketplace index does not match state",
                        )
                    known_indexes[marketplace_id] = known
                    indexes[marketplace_id] = verify_marketplace_index(
                        data,
                        root=root,
                    )
                except MarketplaceError as exc:
                    cache_errors[marketplace_id] = exc.code
        except BaseException:
            self._indexes = {}
            self._known_indexes = {}
            self._cache_errors = {}
            raise
        self._indexes = indexes
        self._known_indexes = known_indexes
        self._cache_errors = cache_errors

    def _release_for_digest(
        self,
        digest: str,
        *,
        include_expired: bool,
    ) -> tuple[VerifiedMarketplaceIndex, ReleaseRecord] | None:
        indexes = self._known_indexes if include_expired else self._current_indexes()
        matches = [
            (index, release)
            for index in indexes.values()
            for release in index.releases
            if release.artifact.sha256 == digest
        ]
        if len(matches) > 1:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_RELEASE_CONFLICT",
                "one artifact digest appears in multiple marketplace roots",
            )
        return matches[0] if matches else None

    def _current_indexes(
        self,
        *,
        now: datetime | None = None,
    ) -> dict[str, VerifiedMarketplaceIndex]:
        current = now or datetime.now(UTC)
        return {
            marketplace_id: index
            for marketplace_id, index in self._indexes.items()
            if index.expires_datetime > current
        }

    def _current_cache_errors(
        self,
        current_indexes: Mapping[str, VerifiedMarketplaceIndex],
    ) -> dict[str, str]:
        errors = dict(self._cache_errors)
        for marketplace_id in self._indexes.keys() - current_indexes.keys():
            errors[marketplace_id] = "PLUGIN_MARKETPLACE_INDEX_EXPIRED"
        return errors

    @staticmethod
    def _assert_bundle_release(
        bundle: VerifiedPlatformBundle,
        release: ReleaseRecord,
        publisher: PublisherRecord,
    ) -> None:
        mismatches: dict[str, Any] = {}
        expected = {
            "bundleSha256": release.artifact.sha256,
            "bundleSize": release.artifact.size,
            "manifestSha256": release.artifact.manifest_sha256,
            "pluginId": release.plugin_id,
            "version": release.version,
            "publisher": release.publisher_id,
            "publisherKeyId": publisher.key_id,
            "sbomSha256": release.artifact.sbom_sha256,
        }
        actual = {
            "bundleSha256": bundle.sha256,
            "bundleSize": bundle.size,
            "manifestSha256": bundle.manifest_sha256,
            "pluginId": bundle.manifest.plugin.id,
            "version": bundle.manifest.plugin.version,
            "publisher": bundle.manifest.plugin.publisher,
            "publisherKeyId": publisher.key_id,
            "sbomSha256": next(
                (
                    item.sha256
                    for item in bundle.envelope.contents
                    if item.path == SBOM_PATH
                ),
                None,
            ),
        }
        for key, expected_value in expected.items():
            if actual[key] != expected_value:
                mismatches[key] = {"expected": expected_value, "actual": actual[key]}
        if mismatches:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ARTIFACT_IDENTITY_MISMATCH",
                "bundle identity does not match its signed release",
                details=mismatches,
            )
        PluginMarketplaceService._assert_sbom_release(bundle, release)

    @staticmethod
    def _license_expression(value: Any, label: str) -> str:
        if (
            not isinstance(value, list)
            or len(value) != 1
            or not isinstance(value[0], dict)
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_LICENSE_MISSING",
                f"{label} must contain exactly one license expression",
            )
        item = value[0]
        if set(item) == {"expression"} and isinstance(item["expression"], str):
            result = item["expression"]
        elif (
            set(item) == {"license"}
            and isinstance(item["license"], dict)
            and set(item["license"]) == {"id"}
            and isinstance(item["license"]["id"], str)
        ):
            result = item["license"]["id"]
        else:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_LICENSE_MISSING",
                f"{label} license expression is invalid",
            )
        if not result or len(result) > 256:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_LICENSE_MISSING",
                f"{label} license expression is invalid",
            )
        return result

    @staticmethod
    def _assert_sbom_release(
        bundle: VerifiedPlatformBundle,
        release: ReleaseRecord,
    ) -> None:
        try:
            with zipfile.ZipFile(bundle.path, "r") as archive:
                raw = archive.read(SBOM_PATH)
            value = loads_strict(raw)
        except (OSError, KeyError, zipfile.BadZipFile, PlatformContractError) as exc:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_INVALID",
                "signed release SBOM cannot be read",
            ) from exc
        if not isinstance(value, dict):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_INVALID",
                "signed release SBOM must be an object",
            )
        metadata = value.get("metadata")
        component = metadata.get("component") if isinstance(metadata, dict) else None
        if (
            not isinstance(component, dict)
            or component.get("name") != release.plugin_id
            or component.get("version") != release.version
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_IDENTITY_MISMATCH",
                "SBOM application identity does not match the signed release",
            )
        plugin_license = PluginMarketplaceService._license_expression(
            component.get("licenses"),
            "SBOM metadata.component",
        )
        if plugin_license != release.license_expression:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_LICENSE_MISMATCH",
                "SBOM plugin license does not match signed release metadata",
            )
        components = value.get("components")
        if not isinstance(components, list):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_INVALID",
                "SBOM components must be an array",
            )
        declared: list[dict[str, str]] = []
        for index, item in enumerate(components):
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("name"), str)
                or not isinstance(item.get("version"), str)
            ):
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_SBOM_INVALID",
                    f"SBOM component {index} is invalid",
                )
            name = re.sub(r"[-_.]+", "-", item["name"]).lower()
            declared.append(
                {
                    "name": name,
                    "version": item["version"],
                    "licenseExpression": PluginMarketplaceService._license_expression(
                        item.get("licenses"),
                        f"SBOM components[{index}]",
                    ),
                }
            )
        declared.sort(key=lambda item: (item["name"], item["version"]))
        expected = [item.to_wire() for item in release.dependencies]
        if declared != expected:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_DEPENDENCY_MISMATCH",
                "SBOM dependencies or licenses do not match signed release metadata",
                details={"expected": expected, "actual": declared},
            )
        wheel_dependencies = sorted(
            (re.sub(r"[-_.]+", "-", item.package).lower(), item.version)
            for item in bundle.wheels
        )
        signed_dependencies = [
            (item.name, item.version) for item in release.dependencies
        ]
        if wheel_dependencies != signed_dependencies:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SBOM_DEPENDENCY_MISMATCH",
                "signed dependencies do not cover every bundled wheel exactly",
            )

    def bundle_trust(
        self,
        bundle: VerifiedPlatformBundle,
        *,
        fallback_trust_level: str,
    ) -> BundleTrust:
        known = self._release_for_digest(bundle.sha256, include_expired=True)
        if known is not None:
            known_index, known_release = known
            current_indexes = self._current_indexes()
            valid_index = current_indexes.get(known_index.marketplace_id)
            if valid_index is None:
                cache_errors = self._current_cache_errors(current_indexes)
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_OFFLINE_CACHE_INVALID",
                    "verified publisher activation has no current valid offline index",
                    details={
                        "marketplaceId": known_index.marketplace_id,
                        "reason": cache_errors.get(
                            known_index.marketplace_id,
                            "CACHE_UNAVAILABLE",
                        ),
                    },
                )
            release = valid_index.release_by_digest()[bundle.sha256]
            publisher = valid_index.publisher_by_id()[release.publisher_id]
            if valid_index.is_revoked(release):
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_RELEASE_REVOKED",
                    "verified publisher release is revoked",
                    details={
                        "marketplaceId": valid_index.marketplace_id,
                        "pluginId": release.plugin_id,
                    },
                )
            self._assert_bundle_release(bundle, release, publisher)
            return BundleTrust(
                "verified-publisher",
                f"publisher-key:{publisher.key_id}",
                "signed-marketplace",
                valid_index.marketplace_id,
                release,
            )
        state = self._state()
        candidate = next(
            (
                item
                for item in state["candidates"]
                if item["bundleSha256"] == bundle.sha256
            ),
            None,
        )
        if candidate is not None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_OFFLINE_CACHE_INVALID",
                "signed marketplace candidate has no current verified index",
                details={
                    "marketplaceId": candidate["marketplaceId"],
                    "pluginId": candidate["pluginId"],
                    "reason": self._cache_errors.get(
                        candidate["marketplaceId"],
                        "CACHE_UNAVAILABLE",
                    ),
                },
            )
        local = next(
            (
                item
                for item in state["localBundles"]
                if item["bundleSha256"] == bundle.sha256
            ),
            None,
        )
        if local is not None:
            expected = {
                "pluginId": bundle.manifest.plugin.id,
                "version": bundle.manifest.plugin.version,
                "publisher": bundle.manifest.plugin.publisher,
            }
            if any(local[key] != value for key, value in expected.items()):
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_LOCAL_EVIDENCE_INVALID",
                    "local bundle evidence does not match the immutable bundle",
                )
            return BundleTrust(
                "local-developer",
                manifest_publisher_identity(bundle.manifest),
                "local-file",
                None,
                None,
            )
        return BundleTrust(
            fallback_trust_level,
            manifest_publisher_identity(bundle.manifest),
            "legacy-or-first-party-bootstrap",
            None,
            None,
        )

    def record_local_bundle(self, bundle: VerifiedPlatformBundle) -> None:
        if self._release_for_digest(bundle.sha256, include_expired=True) is not None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_TRUST_DOWNGRADE_DENIED",
                "signed marketplace artifact cannot be relabeled as local",
            )
        with security_lock(self.lock_path):
            state = self._state()
            current = next(
                (
                    item
                    for item in state["localBundles"]
                    if item["bundleSha256"] == bundle.sha256
                ),
                None,
            )
            record = {
                "bundleSha256": bundle.sha256,
                "pluginId": bundle.manifest.plugin.id,
                "version": bundle.manifest.plugin.version,
                "publisher": bundle.manifest.plugin.publisher,
                "recordedAt": _utc_now(),
            }
            if current is not None:
                comparable = {
                    key: current[key] for key in record if key != "recordedAt"
                }
                expected = {key: record[key] for key in record if key != "recordedAt"}
                if comparable != expected:
                    raise MarketplaceError(
                        "PLUGIN_MARKETPLACE_LOCAL_EVIDENCE_INVALID",
                        "local bundle digest was rebound to another identity",
                    )
                return
            state["localBundles"].append(record)
            self._commit_state(state)

    def _cache_index(
        self,
        verified: VerifiedMarketplaceIndex,
    ) -> None:
        path = (
            self.index_directory
            / verified.marketplace_id
            / f"{verified.index_sha256.removeprefix('sha256:')}.json"
        )
        _write_bytes(path, verified.canonical_bytes)

    @staticmethod
    def _assert_index_update(
        current: VerifiedMarketplaceIndex | None,
        candidate: VerifiedMarketplaceIndex,
    ) -> None:
        if current is None:
            if candidate.sequence != 1 or candidate.previous_index_sha256 is not None:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_INDEX_CHAIN_INVALID",
                    "first observed marketplace index must start at sequence 1",
                )
            return
        if candidate.sequence == current.sequence:
            if candidate.index_sha256 != current.index_sha256:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_IMMUTABILITY_VIOLATION",
                    "marketplace index sequence was replaced in place",
                )
            return
        if (
            candidate.sequence != current.sequence + 1
            or candidate.previous_index_sha256 != current.index_sha256
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_INDEX_CHAIN_INVALID",
                "marketplace index sequence or previous digest is invalid",
            )
        if (
            len(candidate.releases) < len(current.releases)
            or candidate.releases[: len(current.releases)] != current.releases
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_IMMUTABILITY_VIOLATION",
                "published releases cannot be removed or replaced",
            )
        old = {
            (item.scope, item.subject, item.reason_code, item.effective_at)
            for item in current.revocations
        }
        new = {
            (item.scope, item.subject, item.reason_code, item.effective_at)
            for item in candidate.revocations
        }
        if not old.issubset(new):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_REVOCATION_ROLLBACK",
                "marketplace revocations are append-only",
            )

    def import_index(
        self,
        data: bytes,
        *,
        marketplace_id: str,
    ) -> dict[str, Any]:
        if not self.enabled:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_DISABLED",
                "signed Marketplace is disabled",
                status_code=404,
            )
        root = self.roots.get(marketplace_id)
        if root is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ROOT_NOT_FOUND",
                "marketplace root is not build-pinned",
                status_code=404,
            )
        verified = verify_marketplace_index(data, root=root)
        with security_lock(self.lock_path):
            self.reload_cache()
            current = self._known_indexes.get(marketplace_id)
            self._assert_index_update(current, verified)
            if current is not None and current.index_sha256 == verified.index_sha256:
                return {
                    "changed": False,
                    "marketplaceId": marketplace_id,
                    "sequence": current.sequence,
                    "indexSha256": current.index_sha256,
                }
            self._cache_index(verified)
            state = self._state()
            replacement = {
                "marketplaceId": marketplace_id,
                "sequence": verified.sequence,
                "indexSha256": verified.index_sha256,
                "cacheFile": f"{verified.index_sha256.removeprefix('sha256:')}.json",
                "importedAt": _utc_now(),
            }
            state["indexes"] = [
                item
                for item in state["indexes"]
                if item["marketplaceId"] != marketplace_id
            ]
            state["indexes"].append(replacement)
            self._commit_state(state)
            self.reload_cache()
        return {
            "changed": True,
            "marketplaceId": marketplace_id,
            "sequence": verified.sequence,
            "indexSha256": verified.index_sha256,
            "releaseCount": len(verified.releases),
            "revocationCount": len(verified.revocations),
        }

    def refresh(self, marketplace_id: str) -> dict[str, Any]:
        root = self.roots.get(marketplace_id)
        if not self.enabled or root is None or not root.enabled:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ROOT_NOT_FOUND",
                "marketplace root is unavailable",
                status_code=404,
            )
        data = self.fetcher.get(root.index_url, maximum=MAX_INDEX_BYTES)
        return self.import_index(data, marketplace_id=marketplace_id)

    def _active_record(self, plugin_id: str) -> Any | None:
        return (
            load_activation_registry(self.installer.registry_path)
            .by_id()
            .get(plugin_id)
        )

    def _candidate(
        self, state: Mapping[str, Any], plugin_id: str
    ) -> dict[str, Any] | None:
        return next(
            (item for item in state["candidates"] if item["pluginId"] == plugin_id),
            None,
        )

    def _release(
        self,
        plugin_id: str,
        version: str | None = None,
    ) -> tuple[VerifiedMarketplaceIndex, ReleaseRecord, PublisherRecord]:
        matches = [
            (index, release)
            for index in self._current_indexes().values()
            for release in index.releases
            if release.plugin_id == plugin_id
            and (version is None or release.version == version)
            and not index.is_revoked(release)
        ]
        if not matches:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_RELEASE_NOT_FOUND",
                "marketplace release is unavailable",
                status_code=404,
            )
        if version is None:
            maximum = max(_version_key(release.version) for _index, release in matches)
            matches = [
                item for item in matches if _version_key(item[1].version) == maximum
            ]
        if len(matches) != 1:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_RELEASE_CONFLICT",
                "marketplace release identity is ambiguous",
            )
        index, release = matches[0]
        return index, release, index.publisher_by_id()[release.publisher_id]

    def _assert_ownership(
        self,
        plugin_id: str,
        release: ReleaseRecord,
        marketplace_id: str,
    ) -> Any | None:
        current = self._active_record(plugin_id)
        if current is None:
            return None
        trust = self._release_for_digest(
            current.bundle_sha256,
            include_expired=True,
        )
        if trust is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ACTIVATION_OWNED",
                "marketplace cannot override a local or first-party activation",
                details={"pluginId": plugin_id},
            )
        current_index, current_release = trust
        if (
            current_index.marketplace_id != marketplace_id
            or current_release.publisher_id != release.publisher_id
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ACTIVATION_OWNED",
                "marketplace cannot replace another source or publisher",
                details={"pluginId": plugin_id},
            )
        if _major(current.version) != _major(release.version):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_MIGRATION_REQUIRED",
                "major-version marketplace updates require a future explicit migration contract",
                details={
                    "fromVersion": current.version,
                    "toVersion": release.version,
                },
            )
        if _version_key(release.version) <= _version_key(current.version):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_UPDATE_NOT_NEWER",
                "marketplace update must have a newer version",
            )
        return current

    def _artifact_path(self, digest: str) -> Path:
        if _SHA256.fullmatch(digest) is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ARTIFACT_INVALID",
                "artifact digest is invalid",
            )
        return self.artifact_directory / f"{digest.removeprefix('sha256:')}.cspkg"

    def prepare(
        self,
        plugin_id: str,
        *,
        version: str | None = None,
        artifact_bytes: bytes | None = None,
    ) -> dict[str, Any]:
        index, release, publisher = self._release(plugin_id, version)
        self._assert_ownership(plugin_id, release, index.marketplace_id)
        if artifact_bytes is None:
            if release.artifact.size > MAX_REMOTE_ARTIFACT_BYTES:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_REMOTE_ARTIFACT_TOO_LARGE",
                    "remote marketplace artifacts exceed the bounded download limit",
                    details={"maximum": MAX_REMOTE_ARTIFACT_BYTES},
                )
            artifact_bytes = self.fetcher.get(
                release.artifact.url,
                maximum=release.artifact.size,
            )
        if (
            len(artifact_bytes) != release.artifact.size
            or _sha256_bytes(artifact_bytes) != release.artifact.sha256
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ARTIFACT_DIGEST_MISMATCH",
                "downloaded artifact does not match signed size and digest",
            )
        self.artifact_directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix="marketplace-",
            suffix=".cspkg",
            dir=self.artifact_directory,
            delete=False,
        ) as temporary:
            temporary.write(artifact_bytes)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        try:
            bundle = verify_platform_bundle(
                temporary_path,
                expected_sha256=release.artifact.sha256,
                host_version=self.installer.host_version,
            )
            self._assert_bundle_release(bundle, release, publisher)
            destination = self._artifact_path(release.artifact.sha256)
            _write_bytes(destination, artifact_bytes)
        finally:
            temporary_path.unlink(missing_ok=True)
        with security_lock(self.lock_path):
            current_index, current_release, _current_publisher = self._release(
                plugin_id,
                release.version,
            )
            if (
                current_index.marketplace_id != index.marketplace_id
                or current_release != release
            ):
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_CANDIDATE_STALE",
                    "marketplace release changed while its artifact was being verified",
                )
            current = self._assert_ownership(
                plugin_id,
                release,
                index.marketplace_id,
            )
            permission_diff = self.installer.preview_permission_diff(
                destination,
                expected_sha256=release.artifact.sha256,
            ).to_wire()
            candidate = {
                "pluginId": plugin_id,
                "version": release.version,
                "marketplaceId": index.marketplace_id,
                "publisherId": release.publisher_id,
                "bundleSha256": release.artifact.sha256,
                "artifactFile": (
                    f"{release.artifact.sha256.removeprefix('sha256:')}.cspkg"
                ),
                "phase": "verified-staged",
                "preparedAt": _utc_now(),
                "fromVersion": current.version if current is not None else None,
                "permissionDiff": permission_diff,
                "compatibility": {
                    "hostVersion": self.installer.host_version,
                    "verified": True,
                },
                "migration": {
                    "required": False,
                    "supported": True,
                    "policy": "same-major-only",
                },
                "observation": {
                    "status": "not-started",
                    "observedAt": None,
                    "detail": None,
                },
            }
            state = self._state()
            state["candidates"] = [
                item for item in state["candidates"] if item["pluginId"] != plugin_id
            ]
            state["candidates"].append(candidate)
            self._commit_state(state)
        return dict(candidate)

    def _verified_candidate(
        self,
        plugin_id: str,
    ) -> tuple[dict[str, Any], ReleaseRecord, PublisherRecord, Path]:
        state = self._state()
        candidate = self._candidate(state, plugin_id)
        if candidate is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_CANDIDATE_NOT_FOUND",
                "plugin has no verified marketplace candidate",
                status_code=404,
            )
        index, release, publisher = self._release(plugin_id, candidate["version"])
        if (
            index.marketplace_id != candidate["marketplaceId"]
            or release.publisher_id != candidate["publisherId"]
            or release.artifact.sha256 != candidate["bundleSha256"]
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_CANDIDATE_STALE",
                "marketplace candidate no longer matches the verified index",
            )
        current = self._active_record(plugin_id)
        if current is None or current.bundle_sha256 != release.artifact.sha256:
            self._assert_ownership(plugin_id, release, index.marketplace_id)
        path = self.artifact_directory / candidate["artifactFile"]
        if (
            path.is_symlink()
            or not path.is_file()
            or _hash_file(path)
            != (
                release.artifact.sha256,
                release.artifact.size,
            )
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_CACHE_INVALID",
                "staged marketplace artifact failed its content-addressed check",
            )
        bundle = verify_platform_bundle(
            path,
            expected_sha256=release.artifact.sha256,
            host_version=self.installer.host_version,
        )
        self._assert_bundle_release(bundle, release, publisher)
        return dict(candidate), release, publisher, path

    def _replace_candidate_in_state(
        self,
        state: dict[str, Any],
        replacement: dict[str, Any],
    ) -> None:
        if self._candidate(state, replacement["pluginId"]) is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_CANDIDATE_NOT_FOUND",
                "plugin has no marketplace candidate",
            )
        state["candidates"] = [
            item
            for item in state["candidates"]
            if item["pluginId"] != replacement["pluginId"]
        ]
        state["candidates"].append(replacement)
        self._commit_state(state)

    def _replace_candidate(self, replacement: dict[str, Any]) -> None:
        with security_lock(self.lock_path):
            self._replace_candidate_in_state(self._state(), replacement)

    def apply(self, plugin_id: str) -> dict[str, Any]:
        with security_lock(self.lock_path):
            candidate, release, _publisher, path = self._verified_candidate(plugin_id)
            activation_savepoint = self.installer.capture_activation_state(plugin_id)
            result = self.installer.install(
                path,
                expected_sha256=release.artifact.sha256,
                enabled=False,
                force_staged=True,
            )
            candidate["phase"] = "activation-staged"
            candidate["permissionDiff"] = result.permission_diff
            try:
                self._replace_candidate_in_state(self._state(), candidate)
            except BaseException as state_error:
                if result.changed:
                    try:
                        self.installer.restore_activation_state(
                            activation_savepoint,
                            expected_activation_id=result.activation_id,
                            expected_grant_record_sha256=(result.grant_record_sha256),
                        )
                    except BaseException as compensation_error:
                        raise MarketplaceError(
                            "PLUGIN_MARKETPLACE_APPLY_COMPENSATION_FAILED",
                            "marketplace candidate commit failed and activation rollback did not complete",
                            details={
                                "pluginId": plugin_id,
                                "activationId": result.activation_id,
                                "stateError": (
                                    f"{type(state_error).__name__}: {state_error}"
                                )[:1024],
                                "compensationError": (
                                    f"{type(compensation_error).__name__}: "
                                    f"{compensation_error}"
                                )[:1024],
                            },
                        ) from compensation_error
                raise
        return {
            "candidate": candidate,
            "installation": result.to_wire(),
        }

    def begin_activation(self, plugin_id: str) -> dict[str, Any]:
        with security_lock(self.lock_path):
            candidate, release, _publisher, _path = self._verified_candidate(plugin_id)
            current = self._active_record(plugin_id)
            if (
                current is None
                or current.bundle_sha256 != release.artifact.sha256
                or candidate["phase"] not in {"activation-staged", "observing"}
            ):
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_ACTIVATION_STATE_INVALID",
                    "marketplace candidate is not the current staged activation",
                )
            result = self.installer.enable(plugin_id)
            candidate["phase"] = "observing"
            candidate["observation"] = {
                "status": "observing",
                "observedAt": None,
                "detail": None,
            }
            try:
                self._replace_candidate_in_state(self._state(), candidate)
            except BaseException:
                self.installer.disable(plugin_id)
                raise
        return {"candidate": candidate, "stateChange": result.to_wire()}

    def finish_observation(
        self,
        plugin_id: str,
        *,
        healthy: bool,
        detail: str,
    ) -> dict[str, Any]:
        with security_lock(self.lock_path):
            state = self._state()
            candidate = self._candidate(state, plugin_id)
            if candidate is None or candidate["phase"] != "observing":
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_OBSERVATION_INVALID",
                    "marketplace candidate is not under health observation",
                )
            if healthy:
                _verified, release, _publisher, _path = self._verified_candidate(
                    plugin_id
                )
                current = self._active_record(plugin_id)
                if (
                    current is None
                    or current.state != "active"
                    or current.bundle_sha256 != release.artifact.sha256
                ):
                    raise MarketplaceError(
                        "PLUGIN_MARKETPLACE_OBSERVATION_INVALID",
                        "marketplace candidate lost its active verified activation",
                    )
            replacement = dict(candidate)
            replacement["phase"] = "active" if healthy else "failed"
            replacement["observation"] = {
                "status": "passed" if healthy else "failed",
                "observedAt": _utc_now(),
                "detail": detail[:512],
            }
            self._replace_candidate_in_state(state, replacement)
        return replacement

    def mark_rolled_back(self, plugin_id: str, *, detail: str) -> None:
        with security_lock(self.lock_path):
            state = self._state()
            candidate = self._candidate(state, plugin_id)
            if candidate is None:
                return
            replacement = dict(candidate)
            replacement["phase"] = "rolled-back"
            replacement["observation"] = {
                "status": "rolled-back",
                "observedAt": _utc_now(),
                "detail": detail[:512],
            }
            self._replace_candidate_in_state(state, replacement)

    def enforce_trust_policy(self) -> tuple[str, ...]:
        changed: list[str] = []
        with security_lock(self.lock_path):
            state = self._state()
            registry = load_activation_registry(self.installer.registry_path)
            current_indexes = self._current_indexes()
            for record in registry.plugins:
                if record.state != "active":
                    continue
                known = self._release_for_digest(
                    record.bundle_sha256,
                    include_expired=True,
                )
                if known is None:
                    candidate = next(
                        (
                            item
                            for item in state["candidates"]
                            if item["bundleSha256"] == record.bundle_sha256
                        ),
                        None,
                    )
                    if candidate is None:
                        continue
                    result = self.installer.disable(record.plugin_id)
                    if result.changed:
                        changed.append(record.plugin_id)
                    continue
                index, release = known
                valid = current_indexes.get(index.marketplace_id)
                blocked = valid is None or valid.is_revoked(release)
                if blocked:
                    result = self.installer.disable(record.plugin_id)
                    if result.changed:
                        changed.append(record.plugin_id)
        return tuple(changed)

    def _update_for_record(self, record: Any) -> dict[str, Any]:
        state = self._state()
        candidate = self._candidate(state, record.plugin_id)
        known = self._release_for_digest(record.bundle_sha256, include_expired=True)
        if known is None:
            conflicts = any(
                release.plugin_id == record.plugin_id
                for index in self._current_indexes().values()
                for release in index.releases
            )
            return {
                "policy": "signed-marketplace-or-local-artifact",
                "automatic": False,
                "available": False,
                "ownership": "local-or-first-party",
                "reason": (
                    "MARKETPLACE_CANNOT_OVERRIDE_LOCAL_ACTIVATION"
                    if conflicts
                    else "NO_SIGNED_UPDATE"
                ),
                "candidate": candidate,
                "latest": None,
            }
        current_index, current_release = known
        matches = [
            (index, release)
            for index in self._current_indexes().values()
            for release in index.releases
            if release.plugin_id == record.plugin_id
            and release.publisher_id == current_release.publisher_id
            and index.marketplace_id == current_index.marketplace_id
            and not index.is_revoked(release)
            and _major(release.version) == _major(record.version)
            and _version_key(release.version) > _version_key(record.version)
        ]
        latest = (
            max(matches, key=lambda item: _version_key(item[1].version))[1]
            if matches
            else None
        )
        return {
            "policy": "signed-marketplace-or-local-artifact",
            "automatic": False,
            "available": latest is not None,
            "ownership": "signed-marketplace",
            "reason": None if latest is not None else "NO_NEWER_SIGNED_RELEASE",
            "candidate": candidate,
            "latest": (
                latest.to_public_wire(
                    revoked=False,
                )
                if latest is not None
                else None
            ),
        }

    def update_status(self, plugin_id: str) -> dict[str, Any]:
        record = self._active_record(plugin_id)
        if record is None:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_PLUGIN_NOT_FOUND",
                "plugin is not installed",
                status_code=404,
            )
        return self._update_for_record(record)

    def public_catalog(self) -> dict[str, Any]:
        current_indexes = self._current_indexes()
        cache_errors = self._current_cache_errors(current_indexes)
        plugins: dict[str, list[tuple[VerifiedMarketplaceIndex, ReleaseRecord]]] = {}
        for index in current_indexes.values():
            for release in index.releases:
                plugins.setdefault(release.plugin_id, []).append((index, release))
        entries = []
        installed = load_activation_registry(self.installer.registry_path).by_id()
        for plugin_id in sorted(plugins):
            releases = sorted(
                plugins[plugin_id],
                key=lambda item: _version_key(item[1].version),
                reverse=True,
            )
            installable_release = next(
                (
                    (index, release)
                    for index, release in releases
                    if not index.is_revoked(release)
                ),
                None,
            )
            latest_index, latest = installable_release or releases[0]
            publisher = latest_index.publisher_by_id()[latest.publisher_id]
            entries.append(
                {
                    "pluginId": plugin_id,
                    "publisher": publisher.to_public_wire(),
                    "latest": latest.to_public_wire(
                        revoked=latest_index.is_revoked(latest)
                    ),
                    "releaseCount": len(releases),
                    "installedVersion": (
                        installed[plugin_id].version if plugin_id in installed else None
                    ),
                    "installable": (
                        installable_release is not None
                        and latest.artifact.size <= MAX_REMOTE_ARTIFACT_BYTES
                        and (
                            plugin_id not in installed
                            or self._release_for_digest(
                                installed[plugin_id].bundle_sha256,
                                include_expired=True,
                            )
                            is not None
                        )
                    ),
                }
            )
        return {
            "schemaVersion": CATALOG_SCHEMA_VERSION,
            "enabled": self.enabled,
            "marketplaces": [
                {
                    **root.to_public_wire(),
                    "cache": (
                        {
                            "status": "valid",
                            "sequence": current_indexes[root.marketplace_id].sequence,
                            "expiresAt": current_indexes[
                                root.marketplace_id
                            ].expires_at,
                        }
                        if root.marketplace_id in current_indexes
                        else {
                            "status": "invalid-or-empty",
                            "reason": cache_errors.get(root.marketplace_id),
                        }
                    ),
                }
                for root in sorted(
                    self.roots.values(), key=lambda item: item.marketplace_id
                )
            ],
            "plugins": entries,
        }

    def status(self) -> dict[str, Any]:
        state = self._state()
        registry = load_activation_registry(self.installer.registry_path)
        current_indexes = self._current_indexes()
        cache_errors = self._current_cache_errors(current_indexes)
        return {
            "schemaVersion": STATUS_SCHEMA_VERSION,
            "enabled": self.enabled,
            "automaticUpdates": False,
            "rootCount": len(self.roots),
            "validCacheCount": len(current_indexes),
            "cacheErrors": dict(sorted(cache_errors.items())),
            "candidates": list(state["candidates"]),
            "updates": [
                {
                    "pluginId": record.plugin_id,
                    **self._update_for_record(record),
                }
                for record in registry.plugins
            ],
        }
