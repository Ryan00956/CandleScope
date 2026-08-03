from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path


def _can_read(path: str) -> bool:
    try:
        Path(path).read_bytes()
    except OSError:
        return False
    return True


def _can_write(path: str) -> bool:
    try:
        Path(path).write_text("sandbox-probe", encoding="utf-8")
    except OSError:
        return False
    return True


def _can_connect(address: str, port: int) -> bool:
    try:
        with socket.create_connection((address, port), timeout=1.0):
            return True
    except OSError:
        return False


def _child_process_denied() -> bool:
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-S", "-c", "pass"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    return completed.returncode != 0


def main() -> int:
    if len(sys.argv) != 6:
        raise SystemExit(
            "usage: probe SECRET SOURCE INSTALL_WRITE PRIVATE_WRITE LOOPBACK_PORT"
        )
    secret, source, installation_write, private_write, port = sys.argv[1:]
    result = {
        "secretRead": _can_read(secret),
        "sourceRead": _can_read(source),
        "installationWrite": _can_write(installation_write),
        "privateWrite": _can_write(private_write),
        "loopbackDenied": not _can_connect("127.0.0.1", int(port)),
        "externalDenied": not _can_connect("1.1.1.1", 53),
        "childProcessDenied": _child_process_denied(),
    }
    print(json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
