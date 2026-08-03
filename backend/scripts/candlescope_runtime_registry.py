"""Explicit administration CLI for CandleScope's managed Runtime Registry."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from app.plugin_runtime_registry_v3 import (
    OFFICIAL_REGISTRY_PATH,
    OFFICIAL_ROOTS_PATH,
    ManagedRuntimeRegistryService,
    RuntimeRegistryError,
)


def _service(args: argparse.Namespace) -> ManagedRuntimeRegistryService:
    return ManagedRuntimeRegistryService.from_files(
        root=args.root,
        roots_path=args.roots,
        registry_path=args.bootstrap_registry,
        enabled=True,
        # Registry revision import is deliberately file-based and explicit.
        # This switch must not turn into an automatic network updater.
        network_updates_enabled=False,
    )


def _reference_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--activation-registry", type=Path)
    parser.add_argument("--history-directory", type=Path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect and explicitly administer CandleScope Host-managed runtimes. "
            "No command falls back to a system runtime or compiles from source."
        )
    )
    parser.add_argument(
        "--root",
        type=Path,
        required=True,
        help="Dedicated managed-runtime state directory",
    )
    parser.add_argument("--roots", type=Path, default=OFFICIAL_ROOTS_PATH)
    parser.add_argument(
        "--bootstrap-registry", type=Path, default=OFFICIAL_REGISTRY_PATH
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser(
        "status", help="Print signed registry and cache state"
    )
    _reference_arguments(status)

    ensure = subparsers.add_parser(
        "ensure", help="Install or re-probe one exact signed Host-managed runtime"
    )
    ensure.add_argument("runtime_id")
    ensure.add_argument("kind", choices=("java", "node", "wasm"))
    ensure.add_argument("--offline", action="store_true")
    ensure.add_argument("--os", dest="operating_system")
    ensure.add_argument("--arch", dest="architecture")

    import_registry = subparsers.add_parser(
        "import-registry",
        help="Explicitly activate the next signed revision from a local file",
    )
    import_registry.add_argument("document", type=Path)

    subparsers.add_parser(
        "rollback-registry", help="Return to the prior accepted signed revision"
    )

    add_system = subparsers.add_parser(
        "add-system-runtime",
        help="Explicitly bind a non-reproducible developer-local system runtime",
    )
    add_system.add_argument("runtime_id")
    add_system.add_argument("kind", choices=("java", "node", "wasm"))
    add_system.add_argument("version")
    add_system.add_argument("executable", type=Path)
    add_system.add_argument(
        "--probe-arg",
        action="append",
        default=[],
        help="Repeat for every version-probe argument",
    )
    add_system.add_argument("--expected-pattern", required=True)
    add_system.add_argument("--developer-local", action="store_true", required=True)
    add_system.add_argument(
        "--confirm-nonreproducible", action="store_true", required=True
    )

    system = subparsers.add_parser(
        "system-runtime", help="Re-probe one previously selected system runtime"
    )
    system.add_argument("runtime_id")
    system.add_argument("kind", choices=("java", "node", "wasm"))

    cleanup = subparsers.add_parser(
        "cleanup", help="Recoverably retire an unreferenced extracted runtime cache"
    )
    cleanup.add_argument("artifact_sha256")
    _reference_arguments(cleanup)
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    service = _service(args)
    if args.command == "status":
        return service.public_status(
            activation_registry=args.activation_registry,
            history_directory=args.history_directory,
        )
    if args.command == "ensure":
        return service.ensure(
            args.runtime_id,
            args.kind,
            offline=args.offline,
            operating_system=args.operating_system,
            architecture=args.architecture,
        ).to_public_wire()
    if args.command == "import-registry":
        return service.activate_registry(args.document.read_bytes())
    if args.command == "rollback-registry":
        return service.rollback_registry()
    if args.command == "add-system-runtime":
        return service.register_system_runtime(
            runtime_id=args.runtime_id,
            kind=args.kind,
            version=args.version,
            executable=args.executable,
            probe_args=tuple(args.probe_arg),
            expected_pattern=args.expected_pattern,
            developer_local=args.developer_local,
            confirm_nonreproducible=args.confirm_nonreproducible,
        ).to_wire()
    if args.command == "system-runtime":
        return service.system_runtime(args.runtime_id, args.kind).to_wire()
    if args.command == "cleanup":
        return service.cleanup_unreferenced(
            args.artifact_sha256,
            activation_registry=args.activation_registry,
            history_directory=args.history_directory,
        )
    raise AssertionError("argparse accepted an unknown Runtime Registry command")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        value = run(args)
    except RuntimeRegistryError as exc:
        print(
            json.dumps({"ok": False, "error": exc.to_dict()}, sort_keys=True),
            file=sys.stderr,
        )
        return 2
    except OSError as exc:
        error = {
            "ok": False,
            "error": {
                "code": "PLUGIN_RUNTIME_REGISTRY_CLI_IO_FAILED",
                "message": "Runtime Registry CLI could not read a requested local file",
                "details": {"errorType": type(exc).__name__},
            },
        }
        print(json.dumps(error, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "result": value}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
