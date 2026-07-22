"""Explicit ``candlescope-plugin v2`` command surface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import PlatformContractError, loads_strict

from app.plugin_security_v2 import PlatformSecurityError

from .bundle import (
    DEFAULT_HOST_VERSION,
    DEFAULT_PYTHON_REQUIRES,
    build_platform_bundle,
    inspect_platform_bundle,
)
from .errors import PlatformInstallerBaseError, PlatformInstallerError
from .installer import PlatformPluginInstaller


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="candlescope-plugin v2",
        description="Build and manage explicit CandleScope Plugin Platform schema-v2 bundles.",
    )
    parser.add_argument("--root", type=Path)
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--python", type=Path, dest="python_executable")
    parser.add_argument("--host-version", default=DEFAULT_HOST_VERSION)
    parser.add_argument("--json", action="store_true", dest="as_json")
    commands = parser.add_subparsers(dest="command", required=True)

    build = commands.add_parser(
        "build", help="build a deterministic v2 bundle from a layout"
    )
    build.add_argument("source", type=Path)
    build.add_argument("output", type=Path)
    build.add_argument("--python-requires", default=DEFAULT_PYTHON_REQUIRES)
    build.add_argument(
        "--os",
        action="append",
        choices=("windows", "linux", "macos"),
        dest="operating_systems",
    )
    build.add_argument(
        "--arch", action="append", choices=("x86_64", "arm64"), dest="architectures"
    )
    build.add_argument("--force", action="store_true")

    inspect = commands.add_parser(
        "inspect", help="strictly inspect an unpinned local v2 bundle"
    )
    inspect.add_argument("bundle", type=Path)

    install = commands.add_parser(
        "install", help="verify, isolate, probe, then atomically register a v2 bundle"
    )
    install.add_argument("bundle", type=Path)
    install.add_argument("--sha256", required=True)
    install.add_argument("--enable", action="store_true")

    check = commands.add_parser(
        "check", help="verify immutable content and rerun a fresh probe"
    )
    check.add_argument("plugin_id")
    commands.add_parser(
        "list", help="list v2 activations without loading the v1 registry"
    )
    permissions = commands.add_parser(
        "permissions", help="show grant intent, decisions, and redacted scopes"
    )
    permissions.add_argument("plugin_id", nargs="?")
    permission_diff = commands.add_parser(
        "permission-diff", help="preview a pinned bundle's permission changes"
    )
    permission_diff.add_argument("bundle", type=Path)
    permission_diff.add_argument("--sha256", required=True)
    grant = commands.add_parser("grant", help="grant one declared permission")
    grant.add_argument("plugin_id")
    grant.add_argument("permission_id")
    scope = grant.add_mutually_exclusive_group()
    scope.add_argument("--scope-json")
    scope.add_argument("--scope-file", type=Path)
    for command, help_text in (
        ("deny", "deny one declared permission"),
        ("revoke", "revoke one previously decided permission"),
    ):
        item = commands.add_parser(command, help=help_text)
        item.add_argument("plugin_id")
        item.add_argument("permission_id")
    for command, help_text in (
        ("enable", "enable a validated plugin after permission negotiation"),
        ("disable", "disable a v2 activation"),
        ("rollback", "restore the exact previous v2 activation"),
        ("uninstall", "remove the v2 activation while retaining immutable content"),
    ):
        item = commands.add_parser(command, help=help_text)
        item.add_argument("plugin_id")
    return parser


def _installer(args: argparse.Namespace) -> PlatformPluginInstaller:
    return PlatformPluginInstaller(
        root=args.root,
        registry_path=args.registry,
        python_executable=args.python_executable,
        host_version=args.host_version,
    )


def _grant_scope(args: argparse.Namespace) -> dict[str, Any] | None:
    text: str | None = args.scope_json
    if args.scope_file is not None:
        source = args.scope_file.expanduser()
        path = source.resolve(strict=False)
        try:
            valid = (
                not source.is_symlink()
                and path.is_file()
                and path.stat().st_size <= 64 * 1024
            )
            if not valid:
                raise PlatformInstallerError(
                    "grant scope file must be a regular file no larger than 64 KiB"
                )
            text = path.read_text(encoding="utf-8")
        except PlatformInstallerError:
            raise
        except (OSError, UnicodeError) as exc:
            raise PlatformInstallerError(
                f"unable to read grant scope file: {exc}"
            ) from exc
    if text is None:
        return None
    try:
        value = loads_strict(text)
    except PlatformContractError as exc:
        raise PlatformInstallerError(
            "grant scope must be strict JSON",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc
    if not isinstance(value, dict):
        raise PlatformInstallerError("grant scope must be a JSON object")
    return value


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "build":
        bundle = build_platform_bundle(
            args.source,
            args.output,
            python_requires=args.python_requires,
            operating_systems=tuple(
                sorted(args.operating_systems or ("linux", "macos", "windows"))
            ),
            architectures=tuple(sorted(args.architectures or ("arm64", "x86_64"))),
            host_version=args.host_version,
            force=args.force,
        )
        return {"ok": True, "bundle": bundle.to_wire()}
    if args.command == "inspect":
        return {
            "ok": True,
            "bundle": inspect_platform_bundle(
                args.bundle, host_version=args.host_version
            ).to_wire(),
        }
    installer = _installer(args)
    if args.command == "install":
        return {
            "ok": True,
            "installation": installer.install(
                args.bundle,
                expected_sha256=args.sha256,
                enabled=args.enable,
            ).to_wire(),
        }
    if args.command == "check":
        return {"ok": True, "check": installer.check(args.plugin_id).to_wire()}
    if args.command == "list":
        return {"ok": True, "plugins": list(installer.list_plugins())}
    if args.command == "permissions":
        return {
            "ok": True,
            "grants": list(installer.permission_summary(args.plugin_id)),
        }
    if args.command == "permission-diff":
        return {
            "ok": True,
            "permissionDiff": installer.preview_permission_diff(
                args.bundle,
                expected_sha256=args.sha256,
            ).to_wire(),
        }
    if args.command == "grant":
        return {
            "ok": True,
            "permissionChange": installer.grant_permission(
                args.plugin_id,
                args.permission_id,
                scope=_grant_scope(args),
            ).to_wire(),
        }
    if args.command == "deny":
        return {
            "ok": True,
            "permissionChange": installer.deny_permission(
                args.plugin_id,
                args.permission_id,
            ).to_wire(),
        }
    if args.command == "revoke":
        return {
            "ok": True,
            "permissionChange": installer.revoke_permission(
                args.plugin_id,
                args.permission_id,
            ).to_wire(),
        }
    if args.command == "enable":
        return {"ok": True, "change": installer.enable(args.plugin_id).to_wire()}
    if args.command == "disable":
        return {"ok": True, "change": installer.disable(args.plugin_id).to_wire()}
    if args.command == "rollback":
        return {"ok": True, "rollback": installer.rollback(args.plugin_id).to_wire()}
    if args.command == "uninstall":
        return {"ok": True, "change": installer.uninstall(args.plugin_id).to_wire()}
    raise PlatformInstallerError(f"unsupported v2 command: {args.command}")


def _emit(payload: dict[str, Any], *, compact: bool, stream: Any) -> None:
    print(
        json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            **({"separators": (",", ":")} if compact else {"indent": 2}),
        ),
        file=stream,
    )


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        payload = _execute(args)
    except (PlatformInstallerBaseError, PlatformSecurityError) as exc:
        _emit(
            {"ok": False, "error": exc.to_dict()},
            compact=args.as_json,
            stream=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        _emit(
            {
                "ok": False,
                "error": {
                    "code": "PLUGIN_PLATFORM_INSTALLER_INTERRUPTED",
                    "message": "plugin operation was interrupted",
                },
            },
            compact=args.as_json,
            stream=sys.stderr,
        )
        return 130
    _emit(payload, compact=args.as_json, stream=sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
