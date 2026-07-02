"""Stable identity helpers for backend-hosted indicator implementations."""
from __future__ import annotations

import hashlib
import inspect
from functools import lru_cache
from pathlib import Path


def script_hash(script: str) -> str:
    """Return a full SHA-256 hash for the final script text."""
    return hashlib.sha256(str(script or "").encode("utf-8")).hexdigest()


def short_script_hash(script: str, length: int = 12) -> str:
    """Return a short display-safe script hash prefix."""
    return script_hash(script)[:max(1, int(length or 12))]


@lru_cache(maxsize=256)
def source_file_hash(path: str, length: int = 12) -> str:
    """Return a short SHA-256 hash for a source file."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return ""
    return hashlib.sha256(data).hexdigest()[:max(1, int(length or 12))]


def object_source_hash(obj: object, length: int = 12) -> str:
    """Return a stable hash for the source file that defines an object."""
    try:
        path = inspect.getsourcefile(obj)
    except (OSError, TypeError):
        path = None
    if path:
        return source_file_hash(path, length=length)
    try:
        source = inspect.getsource(obj)
    except (OSError, TypeError):
        return ""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:max(1, int(length or 12))]
