"""Explicitly drop WP-C account metadata and restore Broker state schema v1."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
for source_root in (BACKEND_ROOT, SDK_SOURCE):
    source = str(source_root)
    if source not in sys.path:
        sys.path.insert(0, source)

from app.plugin_host.framing import strict_json_loads  # noqa: E402
from app.plugin_live_v2.journal import SHADOW_JOURNAL_FILENAME  # noqa: E402
from app.plugin_live_v2.state import (  # noqa: E402
    BROKER_STATE_SCHEMA_V1,
    BROKER_STATE_SCHEMA_VERSION,
    MAX_BROKER_STATE_BYTES,
    BrokerStateStore,
)


def _atomic_write(path: Path, payload: bytes) -> None:
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        with temporary.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def downgrade_live_broker_state(
    root: Path | str,
    *,
    backup_path: Path | str,
    confirm_drop_account_bindings: bool = False,
) -> dict[str, Any]:
    """Validate and atomically downgrade exactly one schema-v2 Broker state."""

    broker_root = Path(root).expanduser().resolve(strict=False)
    state_path = broker_root / "broker-state-v1.json"
    backup = Path(backup_path).expanduser().resolve(strict=False)
    shadow_paths = tuple(
        broker_root / f"{SHADOW_JOURNAL_FILENAME}{suffix}"
        for suffix in ("", "-wal", "-shm")
    )
    if any(
        path.exists() or path.is_symlink()
        for path in shadow_paths
    ):
        raise ValueError(
            "WP-D shadow journal must be archived before Broker state downgrade"
        )
    if backup == state_path:
        raise ValueError("backup path must differ from Broker state path")
    try:
        raw = state_path.read_bytes()
    except OSError as exc:
        raise ValueError("unable to read Broker state") from exc
    value = strict_json_loads(raw, max_message_bytes=MAX_BROKER_STATE_BYTES)
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != BROKER_STATE_SCHEMA_VERSION
    ):
        raise ValueError("Broker state must use schema v2")
    vault_backend = value.get("vaultBackend")
    if vault_backend not in {"fake", "windows-dpapi"}:
        raise ValueError("Broker state vault backend is invalid")

    store = BrokerStateStore(
        broker_root,
        vault_backend=vault_backend,
        accounts_enabled=False,
    )
    state = store.load_or_create()
    account_count = len(state.accounts)
    if account_count and not confirm_drop_account_bindings:
        raise ValueError(
            "account bindings exist; explicit drop confirmation is required"
        )
    if backup.exists():
        raise ValueError("backup path already exists")
    backup.parent.mkdir(parents=True, exist_ok=True)
    try:
        with backup.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        raise ValueError("unable to create exclusive Broker state backup") from exc

    downgraded = replace(state, accounts=())
    encoded = (
        json.dumps(
            downgraded.to_wire(schema_version=BROKER_STATE_SCHEMA_V1),
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )
    if len(encoded) > MAX_BROKER_STATE_BYTES:
        raise ValueError("downgraded Broker state exceeds its hard limit")
    _atomic_write(state_path, encoded)
    return {
        "schemaVersionBefore": BROKER_STATE_SCHEMA_VERSION,
        "schemaVersionAfter": BROKER_STATE_SCHEMA_V1,
        "droppedAccountBindingCount": account_count,
        "retainedCredentialCount": len(state.credentials),
        "backupPath": str(backup),
        "backupSha256": hashlib.sha256(raw).hexdigest(),
        "stateSha256": hashlib.sha256(encoded).hexdigest(),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--backup-path", required=True, type=Path)
    parser.add_argument(
        "--confirm-drop-account-bindings",
        action="store_true",
        help="required when schema v2 contains any WP-C account binding",
    )
    return parser


def main() -> int:
    args = _parser().parse_args()
    result = downgrade_live_broker_state(
        args.root,
        backup_path=args.backup_path,
        confirm_drop_account_bindings=args.confirm_drop_account_bindings,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
