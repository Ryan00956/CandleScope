"""Private inherited-pipe entrypoint for the Live Broker foundation."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, BinaryIO

if __package__ in {None, ""}:
    backend_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(backend_root))
    sdk_source = (
        backend_root.parent
        / "packages"
        / "candlescope-plugin-sdk"
        / "src"
    )
    if sdk_source.is_dir():
        sys.path.insert(0, str(sdk_source))

from app.plugin_host.framing import (  # noqa: E402
    JsonLineError,
    compact_json_bytes,
    strict_json_loads,
)
from app.plugin_live_v2.errors import LiveBrokerError, broker_error  # noqa: E402
from app.plugin_live_v2.protocol import (  # noqa: E402
    MAX_BROKER_MESSAGE_BYTES,
    failure_response,
)
from app.plugin_live_v2.service import LiveBrokerService  # noqa: E402


class BrokerDirectoryLock:
    """Hold one non-blocking byte-range/file lock for the worker lifetime."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / "broker.lock"
        self._stream: BinaryIO | None = None

    def __enter__(self) -> "BrokerDirectoryLock":
        self.root.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        try:
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
                os.fsync(stream.fileno())
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            stream.close()
            raise
        self._stream = stream
        return self

    def __exit__(self, *_exc: object) -> None:
        stream = self._stream
        self._stream = None
        if stream is None:
            return
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()


def _safe_sequence(value: Any) -> int:
    if isinstance(value, dict):
        sequence = value.get("sequence")
        if (
            isinstance(sequence, int)
            and not isinstance(sequence, bool)
            and sequence >= 1
        ):
            return sequence
    return 1


def _write_response(value: dict[str, Any]) -> None:
    encoded = compact_json_bytes(
        value,
        max_message_bytes=MAX_BROKER_MESSAGE_BYTES,
    )
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def _protocol_failure(
    service: LiveBrokerService | None,
    value: Any,
    error: LiveBrokerError,
) -> None:
    response = failure_response(
        _safe_sequence(value),
        service.policy_epoch if service is not None else 0,
        error,
    )
    _write_response(response.to_wire())


def run(
    root: Path,
    *,
    vault_backend: str,
    release_lock_path: Path,
    read_only_accounts_enabled: bool,
    reconciliation_shadow_enabled: bool,
    native_control_enabled: bool,
    testnet_execution_enabled: bool,
) -> int:
    service: LiveBrokerService | None = None
    with BrokerDirectoryLock(root):
        try:
            service = LiveBrokerService(
                root,
                vault_backend=vault_backend,
                release_lock_path=release_lock_path,
                read_only_accounts_enabled=read_only_accounts_enabled,
                reconciliation_shadow_enabled=(
                    reconciliation_shadow_enabled
                ),
                native_control_enabled=native_control_enabled,
                testnet_execution_enabled=testnet_execution_enabled,
            )
            while True:
                line = sys.stdin.buffer.readline(MAX_BROKER_MESSAGE_BYTES + 2)
                if not line:
                    return 0
                if (
                    len(line) > MAX_BROKER_MESSAGE_BYTES + 1
                    or not line.endswith(b"\n")
                ):
                    _protocol_failure(
                        service,
                        None,
                        broker_error(
                            "LIVE_BROKER_MESSAGE_INVALID",
                            "Broker request exceeded its framed message limit",
                            fatal=True,
                        ),
                    )
                    return 2
                payload = line[:-1]
                if payload.endswith(b"\r"):
                    payload = payload[:-1]
                value: Any = None
                try:
                    value = strict_json_loads(
                        payload,
                        max_message_bytes=MAX_BROKER_MESSAGE_BYTES,
                    )
                    response = service.handle(value)
                    _write_response(response.to_wire())
                    if service.shutdown_requested:
                        return 0
                except JsonLineError as exc:
                    _protocol_failure(
                        service,
                        value,
                        broker_error(
                            "LIVE_BROKER_MESSAGE_INVALID",
                            "Broker request is not strict UTF-8 JSON",
                            fatal=True,
                            details={"frameCode": exc.code},
                        ),
                    )
                    return 2
                except LiveBrokerError as exc:
                    _protocol_failure(service, value, exc)
                    if exc.fatal:
                        return 2
        finally:
            if service is not None:
                service.close()


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if (
        len(arguments) != 7
        or arguments[3] not in {"accounts-off", "accounts-on"}
        or arguments[4] not in {"shadow-off", "shadow-on"}
        or arguments[5] not in {"control-off", "control-on"}
        or arguments[6] not in {"execution-off", "execution-on"}
        or (
            arguments[4] == "shadow-on"
            and arguments[3] != "accounts-on"
        )
        or (
            arguments[5] == "control-on"
            and arguments[4] != "shadow-on"
        )
        or (
            arguments[6] == "execution-on"
            and arguments[5] != "control-on"
        )
    ):
        print("LIVE_BROKER_ARGUMENTS_INVALID", file=sys.stderr, flush=True)
        return 2
    root = Path(arguments[0]).expanduser().resolve(strict=False)
    release_lock = Path(arguments[2]).expanduser().resolve(strict=False)
    try:
        return run(
            root,
            vault_backend=arguments[1],
            release_lock_path=release_lock,
            read_only_accounts_enabled=arguments[3] == "accounts-on",
            reconciliation_shadow_enabled=arguments[4] == "shadow-on",
            native_control_enabled=arguments[5] == "control-on",
            testnet_execution_enabled=arguments[6] == "execution-on",
        )
    except LiveBrokerError as exc:
        print(exc.code, file=sys.stderr, flush=True)
        return 3
    except (OSError, ValueError):
        print("LIVE_BROKER_START_FAILED", file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
