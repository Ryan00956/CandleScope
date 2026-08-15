"""Inspect and freeze immutable Python strategy bundles. No user-code execution."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import shutil
import stat
import zipfile
from pathlib import Path
from typing import Any, Mapping

from app.backtest.strategy.protocol import StrategyProviderError, canonical_hash
from app.backtest.strategy.python_author_v1 import (
    AUTHOR_CONTRACT,
    BUNDLE_SCHEMA,
    OUTPUT_KINDS,
    REPRODUCIBILITY_CLASSES,
    SIGNAL_CLOCKS,
    load_schema,
)

REQUIRED_FILES = ("strategy.json", "strategy.py", "requirements.lock")
MAX_BUNDLE_BYTES = 1_048_576
MAX_FILES = 16
MAX_SINGLE_FILE_BYTES = 262_144
LIFECYCLE_METHODS = (
    "prepare",
    "warmup",
    "step",
    "on_execution_report",
    "snapshot",
    "restore",
    "close",
)
FORBIDDEN_IMPORT_PREFIXES = (
    "app",
    "sqlite3",
    "socket",
    "http",
    "urllib",
    "requests",
    "subprocess",
    "multiprocessing",
    "ctypes",
    "pathlib",
)


def _reject(code: str, message: str) -> None:
    raise StrategyProviderError(code, message)


def _is_reparse_or_link(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        return True
    if os.name == "nt":
        try:
            attrs = os.lstat(path).st_file_attributes  # type: ignore[attr-defined]
        except AttributeError:
            return False
        return bool(attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    return False


def _normalize_relative(name: str) -> str:
    text = name.replace("\\", "/").strip()
    if not text or text.startswith("/") or text.startswith("../") or "/../" in f"/{text}/":
        _reject("BUNDLE_PATH_INVALID", f"illegal bundle path {name!r}")
    if ":" in text.split("/")[0]:
        _reject("BUNDLE_PATH_INVALID", f"absolute bundle path {name!r}")
    parts = [part for part in text.split("/") if part not in {"", "."}]
    if any(part == ".." for part in parts):
        _reject("BUNDLE_PATH_INVALID", f"illegal bundle path {name!r}")
    return "/".join(parts)


def _hash_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _read_utf8_lf(payload: bytes, label: str) -> str:
    if payload.startswith(b"\xff\xfe") or b"\x00" in payload[:64]:
        _reject("BUNDLE_ENCODING", f"{label} must be UTF-8")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        _reject("BUNDLE_ENCODING", f"{label} must be UTF-8")
        raise exc
    if "\r" in text:
        _reject("BUNDLE_ENCODING", f"{label} must use LF newlines")
    return text


def _collect_directory(root: Path) -> dict[str, bytes]:
    if _is_reparse_or_link(root):
        _reject("BUNDLE_SYMLINK", "bundle root must not be a link or reparse point")
    files: dict[str, bytes] = {}
    for path in sorted(root.rglob("*")):
        if path.is_dir() or path.name == "__pycache__" or "__pycache__" in path.parts:
            continue
        if _is_reparse_or_link(path):
            _reject("BUNDLE_SYMLINK", f"bundle must not contain links: {path.name}")
        relative = _normalize_relative(str(path.relative_to(root)))
        if relative in files:
            _reject("BUNDLE_DUPLICATE", f"duplicate path {relative}")
        data = path.read_bytes()
        if len(data) > MAX_SINGLE_FILE_BYTES:
            _reject("BUNDLE_TOO_LARGE", f"{relative} exceeds the single-file budget")
        files[relative] = data
    return files


def _collect_zip(payload: bytes) -> dict[str, bytes]:
    if len(payload) > MAX_BUNDLE_BYTES:
        _reject("BUNDLE_TOO_LARGE", "zip exceeds the frozen bundle budget")
    from io import BytesIO

    try:
        archive = zipfile.ZipFile(BytesIO(payload))
    except zipfile.BadZipFile as exc:
        _reject("BUNDLE_ZIP_INVALID", "zip is not a valid archive")
        raise exc
    files: dict[str, bytes] = {}
    uncompressed = 0
    for info in archive.infolist():
        name = _normalize_relative(info.filename)
        if info.is_dir():
            continue
        if info.file_size > MAX_SINGLE_FILE_BYTES or uncompressed + info.file_size > MAX_BUNDLE_BYTES:
            _reject("BUNDLE_TOO_LARGE", "zip uncompressed size exceeds budget")
        if stat.S_ISLNK(info.external_attr >> 16):
            _reject("BUNDLE_SYMLINK", f"zip member {name} is a symlink")
        if name in files:
            _reject("BUNDLE_DUPLICATE", f"duplicate path {name}")
        data = archive.read(info)
        uncompressed += len(data)
        files[name] = data
    return files


def _diagnose_source(source: str, manifest: Mapping[str, Any]) -> list[dict[str, object]]:
    diagnostics: list[dict[str, object]] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        diagnostics.append(
            {
                "severity": "ERROR",
                "line": exc.lineno or 1,
                "column": exc.offset or 1,
                "message": "strategy.py is not valid Python",
            }
        )
        return diagnostics
    imported: list[str] = []
    methods: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
        elif isinstance(node, ast.FunctionDef):
            methods.add(node.name)
    for module in imported:
        if any(module == item or module.startswith(item + ".") for item in FORBIDDEN_IMPORT_PREFIXES):
            diagnostics.append(
                {
                    "severity": "ERROR",
                    "line": 1,
                    "column": 1,
                    "message": f"import {module} is outside the V1 author contract",
                }
            )
    missing = [name for name in LIFECYCLE_METHODS if name not in methods]
    if missing:
        diagnostics.append(
            {
                "severity": "ERROR",
                "line": 1,
                "column": 1,
                "message": f"missing lifecycle methods: {', '.join(missing)}",
            }
        )
    entrypoint = str(manifest.get("entrypoint") or "")
    if ":" not in entrypoint:
        diagnostics.append(
            {
                "severity": "ERROR",
                "line": 1,
                "column": 1,
                "message": "entrypoint must be module:Class",
            }
        )
    return diagnostics


def inspect_files(files: Mapping[str, bytes]) -> dict[str, Any]:
    if len(files) > MAX_FILES:
        _reject("BUNDLE_TOO_LARGE", "bundle has too many files")
    total = sum(len(item) for item in files.values())
    if total > MAX_BUNDLE_BYTES:
        _reject("BUNDLE_TOO_LARGE", "bundle exceeds the frozen size budget")
    missing = [name for name in REQUIRED_FILES if name not in files]
    if missing:
        _reject("BUNDLE_INCOMPLETE", f"missing {', '.join(missing)}")
    manifest_text = _read_utf8_lf(files["strategy.json"], "strategy.json")
    source_text = _read_utf8_lf(files["strategy.py"], "strategy.py")
    lock_text = _read_utf8_lf(files["requirements.lock"], "requirements.lock")
    try:
        manifest = json.loads(manifest_text)
    except json.JSONDecodeError as exc:
        _reject("BUNDLE_MANIFEST", "strategy.json must be JSON")
        raise exc
    if not isinstance(manifest, dict):
        _reject("BUNDLE_MANIFEST", "strategy.json must be an object")
    schema = load_schema("python-strategy-bundle-v1.json")
    if manifest.get("schemaVersion") != schema["properties"]["schemaVersion"]["const"]:
        _reject("BUNDLE_MANIFEST", "strategy.json schemaVersion is not frozen")
    if manifest.get("signalClock") not in SIGNAL_CLOCKS:
        _reject("BUNDLE_MANIFEST", "signalClock must be BAR_CLOSE")
    modes = set(manifest.get("outputModes") or [])
    if not modes or not modes.issubset(OUTPUT_KINDS):
        _reject("BUNDLE_MANIFEST", "outputModes must be the frozen strategy outputs")
    if manifest.get("reproducibility") not in REPRODUCIBILITY_CLASSES:
        _reject("BUNDLE_MANIFEST", "reproducibility class is unknown")
    diagnostics = _diagnose_source(source_text, manifest)
    if any(item["severity"] == "ERROR" for item in diagnostics):
        _reject("BUNDLE_STATIC_DIAGNOSTIC", json.dumps(diagnostics, ensure_ascii=False))
    manifest_hash = _hash_bytes(files["strategy.json"])
    source_hash = _hash_bytes(files["strategy.py"])
    lock_hash = _hash_bytes(files["requirements.lock"])
    canonical = {
        "schemaVersion": BUNDLE_SCHEMA,
        "authorContract": AUTHOR_CONTRACT,
        "files": {name: _hash_bytes(data) for name, data in sorted(files.items())},
        "manifestHash": manifest_hash,
        "sourceHash": source_hash,
        "requirementsLockHash": lock_hash,
    }
    return {
        "schema_version": BUNDLE_SCHEMA,
        "bundle_hash": canonical_hash(canonical),
        "manifest_hash": manifest_hash,
        "source_hash": source_hash,
        "requirements_lock_hash": lock_hash,
        "sdk_hash": _sdk_identity_hash(),
        "capability_hash": canonical_hash(
            {
                "signalClock": manifest.get("signalClock"),
                "outputModes": manifest.get("outputModes"),
                "requiredFeatures": manifest.get("requiredFeatures"),
                "reproducibility": manifest.get("reproducibility"),
            }
        ),
        "parameter_schema_hash": canonical_hash(manifest.get("parameters") or []),
        "manifest": manifest,
        "diagnostics": diagnostics,
        "files": dict(files),
        "size_bytes": total,
        "file_count": len(files),
    }


def inspect_directory(root: Path) -> dict[str, Any]:
    return inspect_files(_collect_directory(root))


def inspect_zip(payload: bytes) -> dict[str, Any]:
    return inspect_files(_collect_zip(payload))


def _sdk_identity_hash() -> str:
    schema_dir = Path(__file__).with_name("python_author_schemas")
    payload = {
        name: _hash_bytes((schema_dir / name).read_bytes())
        for name in sorted(path.name for path in schema_dir.glob("*.json"))
    }
    return canonical_hash(payload)


def freeze_bundle(inspected: Mapping[str, Any], destination: Path) -> Path:
    if destination.exists():
        _reject("IDENTITY_MUTATION", "immutable bundle directory already exists")
    destination.mkdir(parents=True)
    files: Mapping[str, bytes] = inspected["files"]
    for name, data in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    return destination


def copy_frozen_bundle(source: Path, destination: Path) -> None:
    if destination.exists():
        _reject("IDENTITY_MUTATION", "cannot overwrite a frozen bundle")
    shutil.copytree(source, destination, copy_function=shutil.copy2)
