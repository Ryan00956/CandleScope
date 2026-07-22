"""One-shot Host file handles backed only by user-selected browser bytes."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import secrets
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import HostCallRequest

from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.capabilities import CapabilityLease
from app.plugin_security_v2.errors import PlatformSecurityError, security_error


MAX_USER_FILE_BYTES = 128 * 1024
MAX_USER_FILE_RESOURCES_PER_PLUGIN = 8
MAX_USER_FILE_RESOURCES_GLOBAL = 64
MAX_USER_FILE_RESERVED_BYTES_GLOBAL = (
    MAX_USER_FILE_RESOURCES_GLOBAL * MAX_USER_FILE_BYTES
)
_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
_MEDIA_TYPE = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$")
_HANDLE = re.compile(r"^ufh_[A-Za-z0-9_-]{40,128}$")
_DOWNLOAD = re.compile(r"^ufd_[A-Za-z0-9_-]{40,128}$")
_TEMP_FILE = re.compile(r"^(?:open|save)-[0-9a-f]{48}\.bin$")


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _safe_name(value: Any) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or _FILE_NAME.fullmatch(value) is None
        or value in {".", ".."}
    ):
        raise security_error(
            "PLUGIN_FILE_NAME_INVALID", "selected file name is unsupported"
        )
    return value


def _safe_media_type(value: Any) -> str:
    if not isinstance(value, str) or _MEDIA_TYPE.fullmatch(value.lower()) is None:
        raise security_error(
            "PLUGIN_FILE_MEDIA_TYPE_INVALID", "selected file media type is unsupported"
        )
    return value.lower()


@dataclass(frozen=True, slots=True)
class UserFileSelection:
    handle: str
    name: str
    media_type: str
    max_bytes: int
    expires_in_seconds: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "handle": self.handle,
            "name": self.name,
            "mediaType": self.media_type,
            "maxBytes": self.max_bytes,
            "expiresInSeconds": self.expires_in_seconds,
        }


@dataclass(frozen=True, slots=True)
class UserFileDownload:
    body: bytes
    name: str
    media_type: str
    sha256: str


@dataclass(frozen=True, slots=True)
class _HandleRecord:
    fingerprint: str
    plugin_id: str
    contribution_id: str
    field: str
    permission_id: str
    direction: str
    name: str
    media_type: str
    max_bytes: int
    expires_at: float
    path: Path | None
    lease_fingerprint: str | None = None


@dataclass(frozen=True, slots=True)
class _DownloadRecord:
    fingerprint: str
    plugin_id: str
    name: str
    media_type: str
    size: int
    sha256: str
    lease_fingerprint: str
    expires_at: float
    path: Path


class UserSelectedFileBroker:
    def __init__(
        self,
        root: Path | str,
        audit_log: AuditLog,
        *,
        clock=time.monotonic,
        default_ttl_seconds: int = 300,
    ) -> None:
        self._requested_root = Path(root).absolute()
        self.root = self._requested_root.resolve(strict=False)
        self.audit_log = audit_log
        self.clock = clock
        self.default_ttl_seconds = default_ttl_seconds
        self._lock = threading.RLock()
        self._handles: dict[str, _HandleRecord] = {}
        self._downloads: dict[str, _DownloadRecord] = {}
        self._prepare_root()

    def _prepare_root(self) -> None:
        self._requested_root.mkdir(parents=True, exist_ok=True)
        resolved = self._requested_root.resolve(strict=True)
        if (
            resolved != self._requested_root
            or self._requested_root.is_symlink()
            or not resolved.is_dir()
        ):
            raise security_error(
                "PLUGIN_FILE_STORE_UNSAFE", "Host file handle store is unsafe"
            )
        self.root = resolved
        try:
            children = tuple(resolved.iterdir())
            if any(
                child.is_symlink()
                or not child.is_file()
                or _TEMP_FILE.fullmatch(child.name) is None
                for child in children
            ):
                raise security_error(
                    "PLUGIN_FILE_STORE_UNSAFE",
                    "Host file handle store contains an unexpected entry",
                )
            for child in children:
                child.unlink()
        except PlatformSecurityError:
            raise
        except OSError as exc:
            raise security_error(
                "PLUGIN_FILE_STORE_UNSAFE",
                "Host file handle store could not reclaim crash residue",
            ) from exc

    def _delete_path(self, path: Path | None) -> None:
        if path is None:
            return
        try:
            resolved = path.resolve(strict=False)
            if not resolved.is_relative_to(self.root):
                return
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _owned_file_path(self, path: Path) -> Path:
        try:
            if (
                path.parent != self.root
                or _TEMP_FILE.fullmatch(path.name) is None
                or self.root.is_symlink()
                or self.root.resolve(strict=True) != self.root
                or path.is_symlink()
                or not path.is_file()
                or path.resolve(strict=True) != path
            ):
                raise security_error(
                    "PLUGIN_FILE_STORE_UNSAFE",
                    "Host file handle store changed after selection",
                )
        except PlatformSecurityError:
            raise
        except OSError as exc:
            raise security_error(
                "PLUGIN_FILE_STORE_UNSAFE",
                "Host file handle store changed after selection",
            ) from exc
        return path

    def _purge_expired(self) -> None:
        now = self.clock()
        expired_handles = [
            key for key, value in self._handles.items() if value.expires_at <= now
        ]
        expired_downloads = [
            key for key, value in self._downloads.items() if value.expires_at <= now
        ]
        for key in expired_handles:
            self._delete_path(self._handles.pop(key).path)
        for key in expired_downloads:
            self._delete_path(self._downloads.pop(key).path)

    def _reserved_bytes(self) -> int:
        return sum(item.max_bytes for item in self._handles.values()) + sum(
            item.size for item in self._downloads.values()
        )

    def _reserve_resource(self, plugin_id: str, maximum_bytes: int) -> None:
        plugin_resources = sum(
            item.plugin_id == plugin_id for item in self._handles.values()
        ) + sum(item.plugin_id == plugin_id for item in self._downloads.values())
        if (
            plugin_resources >= MAX_USER_FILE_RESOURCES_PER_PLUGIN
            or len(self._handles) + len(self._downloads)
            >= MAX_USER_FILE_RESOURCES_GLOBAL
            or self._reserved_bytes() + maximum_bytes
            > MAX_USER_FILE_RESERVED_BYTES_GLOBAL
        ):
            raise security_error(
                "PLUGIN_FILE_QUOTA_EXCEEDED",
                "user-selected file resource quota is exhausted",
                plugin_id=plugin_id,
            )

    @staticmethod
    def _limits(
        scope: dict[str, Any], media_type: str, requested_max_bytes: int
    ) -> tuple[int, int]:
        media_types = scope.get("mediaTypes")
        max_bytes = scope.get("maxBytes")
        ttl = scope.get("ttlSeconds", 300)
        if (
            not isinstance(media_types, list)
            or media_type not in media_types
            or isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or isinstance(ttl, bool)
            or not isinstance(ttl, int)
            or not 1 <= max_bytes <= MAX_USER_FILE_BYTES
            or not 1 <= requested_max_bytes <= max_bytes
            or not 1 <= ttl <= 600
        ):
            raise security_error(
                "PLUGIN_FILE_SCOPE_DENIED", "selected file exceeds the granted scope"
            )
        return requested_max_bytes, ttl

    def _new_handle(
        self,
        *,
        plugin_id: str,
        contribution_id: str,
        field: str,
        permission_id: str,
        direction: str,
        name: str,
        media_type: str,
        max_bytes: int,
        ttl: int,
        path: Path | None,
        trace_id: str,
    ) -> UserFileSelection:
        for _attempt in range(8):
            handle = "ufh_" + secrets.token_urlsafe(32)
            fingerprint = _fingerprint(handle)
            if fingerprint not in self._handles:
                break
        else:
            raise security_error(
                "PLUGIN_FILE_HANDLE_COLLISION", "unable to mint a user file handle"
            )
        self._handles[fingerprint] = _HandleRecord(
            fingerprint,
            plugin_id,
            contribution_id,
            field,
            permission_id,
            direction,
            name,
            media_type,
            max_bytes,
            self.clock() + ttl,
            path,
        )
        self.audit_log.append(
            category="gateway",
            action="file.select",
            outcome="allowed",
            trace_id=trace_id,
            plugin_id=plugin_id,
            data={
                "contributionId": contribution_id,
                "field": field,
                "direction": direction,
                "handleFingerprint": fingerprint,
                "maxBytes": max_bytes,
                "ttlSeconds": ttl,
            },
        )
        return UserFileSelection(handle, name, media_type, max_bytes, ttl)

    def stage_open(
        self,
        *,
        plugin_id: str,
        contribution_id: str,
        field: str,
        name: Any,
        media_type: Any,
        body: bytes,
        requested_max_bytes: int,
        scope: dict[str, Any],
        trace_id: str,
    ) -> UserFileSelection:
        safe_name = _safe_name(name)
        safe_media_type = _safe_media_type(media_type)
        max_bytes, ttl = self._limits(scope, safe_media_type, requested_max_bytes)
        if not isinstance(body, bytes) or not 0 < len(body) <= max_bytes:
            raise security_error(
                "PLUGIN_FILE_SIZE_DENIED",
                "selected file exceeds the granted byte limit",
            )
        with self._lock:
            self._purge_expired()
            self._reserve_resource(plugin_id, max_bytes)
            path = self.root / f"open-{secrets.token_hex(24)}.bin"
            try:
                with path.open("xb") as stream:
                    stream.write(body)
                    stream.flush()
            except OSError as exc:
                self._delete_path(path)
                raise security_error(
                    "PLUGIN_FILE_STORE_FAILED", "selected file could not be staged"
                ) from exc
            try:
                return self._new_handle(
                    plugin_id=plugin_id,
                    contribution_id=contribution_id,
                    field=field,
                    permission_id="filesystem.open-user-selected",
                    direction="read",
                    name=safe_name,
                    media_type=safe_media_type,
                    max_bytes=max_bytes,
                    ttl=ttl,
                    path=path,
                    trace_id=trace_id,
                )
            except Exception:
                self._delete_path(path)
                raise

    def prepare_save(
        self,
        *,
        plugin_id: str,
        contribution_id: str,
        field: str,
        name: Any,
        media_type: Any,
        requested_max_bytes: int,
        scope: dict[str, Any],
        trace_id: str,
    ) -> UserFileSelection:
        safe_name = _safe_name(name)
        safe_media_type = _safe_media_type(media_type)
        max_bytes, ttl = self._limits(scope, safe_media_type, requested_max_bytes)
        with self._lock:
            self._purge_expired()
            self._reserve_resource(plugin_id, max_bytes)
            return self._new_handle(
                plugin_id=plugin_id,
                contribution_id=contribution_id,
                field=field,
                permission_id="filesystem.save-user-selected",
                direction="write",
                name=safe_name,
                media_type=safe_media_type,
                max_bytes=max_bytes,
                ttl=ttl,
                path=None,
                trace_id=trace_id,
            )

    def _record_for_call(
        self,
        call: HostCallRequest,
        lease: CapabilityLease,
        *,
        direction: str,
    ) -> tuple[str, _HandleRecord]:
        value = dict(call.params)
        expected = {"handle"} if direction == "read" else {"handle", "bodyBase64"}
        if set(value) != expected or not isinstance(value.get("handle"), str):
            raise security_error(
                "PLUGIN_FILE_PARAMS_INVALID",
                "file handle parameters have an invalid shape",
            )
        handle = value["handle"]
        if _HANDLE.fullmatch(handle) is None:
            raise security_error(
                "PLUGIN_FILE_HANDLE_INVALID", "user file handle is invalid or expired"
            )
        fingerprint = _fingerprint(handle)
        record = self._handles.get(fingerprint)
        if (
            record is None
            or record.expires_at <= self.clock()
            or record.plugin_id != lease.plugin_id
            or record.contribution_id != call.request_context.contribution_id
            or record.permission_id != lease.permission_id
            or record.direction != direction
            or (
                record.lease_fingerprint is not None
                and record.lease_fingerprint != lease.handle_fingerprint
            )
        ):
            raise security_error(
                "PLUGIN_FILE_HANDLE_INVALID", "user file handle is invalid or expired"
            )
        if record.lease_fingerprint is None:
            record = replace(record, lease_fingerprint=lease.handle_fingerprint)
            self._handles[fingerprint] = record
        return fingerprint, record

    def read(self, call: HostCallRequest, lease: CapabilityLease) -> dict[str, Any]:
        with self._lock:
            self._purge_expired()
            fingerprint, record = self._record_for_call(call, lease, direction="read")
            self._handles.pop(fingerprint, None)
            try:
                assert record.path is not None
                body = self._owned_file_path(record.path).read_bytes()
            except OSError as exc:
                raise security_error(
                    "PLUGIN_FILE_READ_FAILED", "selected file could not be read"
                ) from exc
            finally:
                self._delete_path(record.path)
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        self.audit_log.append(
            category="gateway",
            action="file.read",
            outcome="allowed",
            trace_id=call.request_context.trace_id,
            plugin_id=lease.plugin_id,
            data={
                "contributionId": record.contribution_id,
                "handleFingerprint": fingerprint,
                "size": len(body),
            },
        )
        return {
            "name": record.name,
            "mediaType": record.media_type,
            "size": len(body),
            "sha256": digest,
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        }

    def write(self, call: HostCallRequest, lease: CapabilityLease) -> dict[str, Any]:
        with self._lock:
            self._purge_expired()
            fingerprint, record = self._record_for_call(call, lease, direction="write")
            self._handles.pop(fingerprint, None)
            encoded = call.params["bodyBase64"]
            if (
                not isinstance(encoded, str)
                or len(encoded) > ((record.max_bytes + 2) // 3) * 4
            ):
                raise security_error(
                    "PLUGIN_FILE_SIZE_DENIED",
                    "file output exceeds the selected byte limit",
                )
            try:
                body = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise security_error(
                    "PLUGIN_FILE_BODY_INVALID", "file output is not canonical base64"
                ) from exc
            if (
                len(body) > record.max_bytes
                or base64.b64encode(body).decode("ascii") != encoded
            ):
                raise security_error(
                    "PLUGIN_FILE_SIZE_DENIED",
                    "file output exceeds the selected byte limit",
                )
            path = self.root / f"save-{secrets.token_hex(24)}.bin"
            try:
                with path.open("xb") as stream:
                    stream.write(body)
                    stream.flush()
            except OSError as exc:
                self._delete_path(path)
                raise security_error(
                    "PLUGIN_FILE_STORE_FAILED", "file output could not be staged"
                ) from exc
            for _attempt in range(8):
                download_id = "ufd_" + secrets.token_urlsafe(32)
                download_fingerprint = _fingerprint(download_id)
                if download_fingerprint not in self._downloads:
                    break
            else:
                self._delete_path(path)
                raise security_error(
                    "PLUGIN_FILE_HANDLE_COLLISION",
                    "unable to mint a user file download handle",
                    plugin_id=record.plugin_id,
                )
            digest = "sha256:" + hashlib.sha256(body).hexdigest()
            self._downloads[download_fingerprint] = _DownloadRecord(
                download_fingerprint,
                record.plugin_id,
                record.name,
                record.media_type,
                len(body),
                digest,
                lease.handle_fingerprint,
                min(
                    self.clock() + self.default_ttl_seconds,
                    record.expires_at,
                ),
                path,
            )
        self.audit_log.append(
            category="gateway",
            action="file.write",
            outcome="allowed",
            trace_id=call.request_context.trace_id,
            plugin_id=lease.plugin_id,
            data={
                "contributionId": record.contribution_id,
                "handleFingerprint": fingerprint,
                "downloadFingerprint": download_fingerprint,
                "size": len(body),
            },
        )
        return {
            "downloadId": download_id,
            "name": record.name,
            "mediaType": record.media_type,
            "size": len(body),
            "sha256": digest,
        }

    def download(
        self, plugin_id: str, download_id: str, *, trace_id: str
    ) -> UserFileDownload:
        if not isinstance(download_id, str) or _DOWNLOAD.fullmatch(download_id) is None:
            raise security_error(
                "PLUGIN_FILE_DOWNLOAD_INVALID", "file download is invalid or expired"
            )
        fingerprint = _fingerprint(download_id)
        with self._lock:
            self._purge_expired()
            record = self._downloads.get(fingerprint)
            if record is None or record.plugin_id != plugin_id:
                raise security_error(
                    "PLUGIN_FILE_DOWNLOAD_INVALID",
                    "file download is invalid or expired",
                )
            self._downloads.pop(fingerprint, None)
            try:
                body = self._owned_file_path(record.path).read_bytes()
            except OSError as exc:
                raise security_error(
                    "PLUGIN_FILE_DOWNLOAD_FAILED", "file download could not be read"
                ) from exc
            finally:
                self._delete_path(record.path)
        if (
            len(body) != record.size
            or "sha256:" + hashlib.sha256(body).hexdigest() != record.sha256
        ):
            raise security_error(
                "PLUGIN_FILE_DOWNLOAD_INTEGRITY_FAILED",
                "file download failed integrity validation",
            )
        self.audit_log.append(
            category="gateway",
            action="file.download",
            outcome="allowed",
            trace_id=trace_id,
            plugin_id=plugin_id,
            data={"downloadFingerprint": fingerprint, "size": len(body)},
        )
        return UserFileDownload(body, record.name, record.media_type, record.sha256)

    def revoke_plugin(self, plugin_id: str) -> None:
        with self._lock:
            for key, record in tuple(self._handles.items()):
                if record.plugin_id == plugin_id:
                    self._handles.pop(key, None)
                    self._delete_path(record.path)
            for key, record in tuple(self._downloads.items()):
                if record.plugin_id == plugin_id:
                    self._downloads.pop(key, None)
                    self._delete_path(record.path)

    def revoke_leases(self, leases: tuple[CapabilityLease, ...], reason: str) -> None:
        del reason
        fingerprints = {item.handle_fingerprint for item in leases}
        with self._lock:
            for key, record in tuple(self._handles.items()):
                if record.lease_fingerprint in fingerprints:
                    self._handles.pop(key, None)
                    self._delete_path(record.path)
            for key, record in tuple(self._downloads.items()):
                if record.lease_fingerprint in fingerprints:
                    self._downloads.pop(key, None)
                    self._delete_path(record.path)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            self._purge_expired()
            return {
                "openHandles": len(self._handles),
                "pendingDownloads": len(self._downloads),
                "reservedBytes": self._reserved_bytes(),
            }

    def sweep(self) -> None:
        with self._lock:
            self._purge_expired()

    def close(self) -> None:
        with self._lock:
            for record in self._handles.values():
                self._delete_path(record.path)
            for record in self._downloads.values():
                self._delete_path(record.path)
            self._handles.clear()
            self._downloads.clear()
