"""Canonical, atomic, locked storage primitives for v2 security state."""

from __future__ import annotations

import contextlib
import os
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    PlatformContractError,
    canonical_dumps,
    loads_strict,
)

from .errors import PlatformSecurityError, security_error


MAX_SECURITY_DOCUMENT_BYTES = 8 * 1024 * 1024


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_json(
    path: Path | str,
    value: Any,
    *,
    replace_existing: bool = True,
) -> None:
    destination = Path(path).resolve(strict=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.parent.is_symlink():
        raise security_error(
            "PLUGIN_SECURITY_PATH_UNSAFE",
            "security state parent must not be a symlink",
        )
    payload = (canonical_dumps(value) + "\n").encode("utf-8")
    if len(payload) > MAX_SECURITY_DOCUMENT_BYTES:
        raise security_error(
            "PLUGIN_SECURITY_DOCUMENT_TOO_LARGE",
            "security state document exceeds the size limit",
        )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if not replace_existing and destination.exists():
            raise security_error(
                "PLUGIN_SECURITY_IMMUTABLE_EVENT_EXISTS",
                "immutable security event already exists",
            )
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
    except PlatformSecurityError:
        raise
    except OSError as exc:
        raise security_error(
            "PLUGIN_SECURITY_WRITE_FAILED",
            f"unable to write security state: {exc}",
        ) from exc
    finally:
        with contextlib.suppress(OSError):
            temporary.unlink()


def read_json(path: Path | str, label: str) -> Any:
    source = Path(path).resolve(strict=False)
    if source.is_symlink() or not source.is_file():
        raise security_error(
            "PLUGIN_SECURITY_PATH_UNSAFE",
            f"{label} must be a regular file",
        )
    try:
        size = source.stat().st_size
        if not 0 < size <= MAX_SECURITY_DOCUMENT_BYTES:
            raise security_error(
                "PLUGIN_SECURITY_DOCUMENT_INVALID",
                f"{label} has an invalid size",
            )
        return loads_strict(source.read_bytes())
    except PlatformSecurityError:
        raise
    except (OSError, PlatformContractError) as exc:
        raise security_error(
            "PLUGIN_SECURITY_DOCUMENT_INVALID",
            f"unable to read {label}: {exc}",
        ) from exc


def _try_lock(stream: Any) -> bool:
    if os.name == "nt":
        import msvcrt

        try:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    import fcntl

    try:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(stream: Any) -> None:
    if os.name == "nt":
        import msvcrt

        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextmanager
def security_lock(path: Path | str, timeout_seconds: float = 10.0) -> Iterator[None]:
    lock_path = Path(path).resolve(strict=False)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if lock_path.parent.is_symlink():
        raise security_error(
            "PLUGIN_SECURITY_PATH_UNSAFE",
            "security lock parent must not be a symlink",
        )
    deadline = time.monotonic() + timeout_seconds
    with lock_path.open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
        while not _try_lock(stream):
            if time.monotonic() >= deadline:
                raise security_error(
                    "PLUGIN_SECURITY_LOCK_TIMEOUT",
                    "timed out waiting for the security state lock",
                )
            time.sleep(0.05)
        try:
            yield
        finally:
            _unlock(stream)
