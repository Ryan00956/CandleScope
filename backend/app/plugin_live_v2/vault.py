"""Credential vault port with fake and Windows DPAPI-protected backends."""

from __future__ import annotations

import contextlib
import ctypes
import os
import re
import uuid
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Protocol

from .errors import broker_error


MAX_CREDENTIAL_BYTES = 32 * 1024
MAX_PROTECTED_CREDENTIAL_BYTES = 256 * 1024
_RECORD_ID = re.compile(r"^[0-9a-f]{32}$")
_DPAPI_HEADER = b"CANDLESCOPE-LIVE-DPAPI-V1\0"
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _record_id(value: str) -> str:
    if not isinstance(value, str) or _RECORD_ID.fullmatch(value) is None:
        raise broker_error(
            "LIVE_BROKER_VAULT_RECORD_INVALID",
            "vault record identity is invalid",
            fatal=True,
        )
    return value


def _secret_copy(value: bytes | bytearray) -> bytearray:
    if not isinstance(value, (bytes, bytearray)) or not 1 <= len(
        value
    ) <= MAX_CREDENTIAL_BYTES:
        raise broker_error(
            "LIVE_BROKER_SECRET_INVALID",
            "credential secret size is outside the supported range",
        )
    return bytearray(value)


def wipe_secret(value: bytearray) -> None:
    for index in range(len(value)):
        value[index] = 0


class CredentialVault(Protocol):
    backend_name: str

    def store(self, record_id: str, secret: bytes | bytearray) -> None: ...

    def open_secret(
        self, record_id: str
    ) -> AbstractContextManager[bytearray]: ...

    def delete(self, record_id: str) -> None: ...

    def list_record_ids(self) -> set[str]: ...

    def close(self) -> None: ...


class FakeCredentialVault:
    """In-memory backend available only through an explicit test controller."""

    backend_name = "fake"

    def __init__(self) -> None:
        self._records: dict[str, bytearray] = {}

    def store(self, record_id: str, secret: bytes | bytearray) -> None:
        key = _record_id(record_id)
        if key in self._records:
            raise broker_error(
                "LIVE_BROKER_VAULT_CONFLICT",
                "vault record already exists",
                fatal=True,
            )
        self._records[key] = _secret_copy(secret)

    @contextmanager
    def open_secret(self, record_id: str) -> Iterator[bytearray]:
        key = _record_id(record_id)
        stored = self._records.get(key)
        if stored is None:
            raise broker_error(
                "LIVE_BROKER_CREDENTIAL_NOT_FOUND",
                "credential handle is unavailable",
            )
        opened = bytearray(stored)
        try:
            yield opened
        finally:
            wipe_secret(opened)

    def delete(self, record_id: str) -> None:
        stored = self._records.pop(_record_id(record_id), None)
        if stored is not None:
            wipe_secret(stored)

    def list_record_ids(self) -> set[str]:
        return set(self._records)

    def close(self) -> None:
        for secret in self._records.values():
            wipe_secret(secret)
        self._records.clear()


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.c_ulong),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


class WindowsDpapiCredentialVault:
    """Current-user DPAPI ciphertext stored under the private Broker root."""

    backend_name = "windows-dpapi"

    def __init__(self, root: Path | str, *, context: bytes) -> None:
        if os.name != "nt":
            raise broker_error(
                "LIVE_BROKER_VAULT_UNAVAILABLE",
                "Windows DPAPI vault is unavailable on this platform",
                fatal=True,
            )
        if not isinstance(context, bytes) or not context or len(context) > 256:
            raise ValueError("DPAPI context must be non-empty bytes")
        self.root = Path(root).expanduser().resolve(strict=False)
        self._entropy = b"CandleScope Live Broker vault v1\0" + context
        self._crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DataBlob),
            ctypes.c_wchar_p,
            ctypes.POINTER(_DataBlob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(_DataBlob),
        ]
        self._crypt32.CryptProtectData.restype = ctypes.c_int
        self._crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DataBlob),
            ctypes.POINTER(ctypes.c_wchar_p),
            ctypes.POINTER(_DataBlob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(_DataBlob),
        ]
        self._crypt32.CryptUnprotectData.restype = ctypes.c_int
        self._kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        self._kernel32.LocalFree.restype = ctypes.c_void_p

    @staticmethod
    def _blob_from_buffer(
        value: bytes | bytearray,
    ) -> tuple[_DataBlob, ctypes.Array[ctypes.c_ubyte]]:
        if isinstance(value, bytearray):
            buffer = (ctypes.c_ubyte * len(value)).from_buffer(value)
        else:
            buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
        return (
            _DataBlob(
                len(value),
                ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
            ),
            buffer,
        )

    def _protect(self, secret: bytearray) -> bytes:
        source, source_buffer = self._blob_from_buffer(secret)
        entropy, entropy_buffer = self._blob_from_buffer(self._entropy)
        output = _DataBlob()
        _ = source_buffer, entropy_buffer
        if not self._crypt32.CryptProtectData(
            ctypes.byref(source),
            "CandleScope Live Broker credential",
            ctypes.byref(entropy),
            None,
            None,
            _CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(output),
        ):
            raise broker_error(
                "LIVE_BROKER_VAULT_PROTECT_FAILED",
                "Windows DPAPI could not protect the credential",
                fatal=True,
                details={"winError": ctypes.get_last_error()},
            )
        try:
            if not output.pbData or output.cbData <= 0:
                raise broker_error(
                    "LIVE_BROKER_VAULT_PROTECT_FAILED",
                    "Windows DPAPI returned an empty protected credential",
                    fatal=True,
                )
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            if output.pbData:
                self._kernel32.LocalFree(output.pbData)

    def _unprotect(self, protected: bytes) -> bytearray:
        source, source_buffer = self._blob_from_buffer(protected)
        entropy, entropy_buffer = self._blob_from_buffer(self._entropy)
        output = _DataBlob()
        description = ctypes.c_wchar_p()
        _ = source_buffer, entropy_buffer
        if not self._crypt32.CryptUnprotectData(
            ctypes.byref(source),
            ctypes.byref(description),
            ctypes.byref(entropy),
            None,
            None,
            _CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(output),
        ):
            raise broker_error(
                "LIVE_BROKER_VAULT_UNPROTECT_FAILED",
                "Windows DPAPI could not open the credential",
                fatal=True,
                details={"winError": ctypes.get_last_error()},
            )
        try:
            if not output.pbData or not 1 <= output.cbData <= MAX_CREDENTIAL_BYTES:
                raise broker_error(
                    "LIVE_BROKER_VAULT_UNPROTECT_FAILED",
                    "Windows DPAPI returned an invalid credential size",
                    fatal=True,
                )
            view = (ctypes.c_ubyte * output.cbData).from_address(
                ctypes.addressof(output.pbData.contents)
            )
            return bytearray(view)
        finally:
            if description:
                self._kernel32.LocalFree(description)
            if output.pbData:
                self._kernel32.LocalFree(output.pbData)

    def _path(self, record_id: str) -> Path:
        return self.root / f"{_record_id(record_id)}.dpapi"

    def store(self, record_id: str, secret: bytes | bytearray) -> None:
        path = self._path(record_id)
        if path.exists():
            raise broker_error(
                "LIVE_BROKER_VAULT_CONFLICT",
                "vault record already exists",
                fatal=True,
            )
        opened = _secret_copy(secret)
        try:
            protected = self._protect(opened)
        finally:
            wipe_secret(opened)
        if len(protected) > MAX_PROTECTED_CREDENTIAL_BYTES:
            raise broker_error(
                "LIVE_BROKER_VAULT_PROTECT_FAILED",
                "protected credential exceeded its hard size limit",
                fatal=True,
            )
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.root / (
            f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with temporary.open("xb") as stream:
                stream.write(_DPAPI_HEADER)
                stream.write(protected)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            raise broker_error(
                "LIVE_BROKER_VAULT_WRITE_FAILED",
                "unable to atomically persist protected credential",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc
        finally:
            with contextlib.suppress(OSError):
                temporary.unlink(missing_ok=True)

    @contextmanager
    def open_secret(self, record_id: str) -> Iterator[bytearray]:
        path = self._path(record_id)
        try:
            payload = path.read_bytes()
        except OSError as exc:
            raise broker_error(
                "LIVE_BROKER_CREDENTIAL_NOT_FOUND",
                "credential handle is unavailable",
                details={"errorType": type(exc).__name__},
            ) from exc
        if (
            not payload.startswith(_DPAPI_HEADER)
            or not len(_DPAPI_HEADER) < len(payload)
            <= len(_DPAPI_HEADER) + MAX_PROTECTED_CREDENTIAL_BYTES
        ):
            raise broker_error(
                "LIVE_BROKER_VAULT_RECORD_INVALID",
                "protected credential record is invalid",
                fatal=True,
            )
        opened = self._unprotect(payload[len(_DPAPI_HEADER) :])
        try:
            yield opened
        finally:
            wipe_secret(opened)

    def delete(self, record_id: str) -> None:
        try:
            self._path(record_id).unlink(missing_ok=True)
        except OSError as exc:
            raise broker_error(
                "LIVE_BROKER_VAULT_DELETE_FAILED",
                "unable to remove protected credential",
                details={"errorType": type(exc).__name__},
            ) from exc

    def list_record_ids(self) -> set[str]:
        if not self.root.exists():
            return set()
        try:
            paths = tuple(self.root.glob("*.dpapi"))
        except OSError as exc:
            raise broker_error(
                "LIVE_BROKER_VAULT_READ_FAILED",
                "unable to enumerate protected credentials",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc
        record_ids: set[str] = set()
        for path in paths:
            if _RECORD_ID.fullmatch(path.stem) is None:
                raise broker_error(
                    "LIVE_BROKER_VAULT_RECORD_INVALID",
                    "vault contains an invalid record name",
                    fatal=True,
                )
            record_ids.add(path.stem)
        return record_ids

    def close(self) -> None:
        return
