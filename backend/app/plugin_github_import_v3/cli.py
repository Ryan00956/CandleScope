"""Explicit ``candlescope-plugin v3`` assessment, scaffold, and build surface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import PlatformContractError

from app.plugin_installer_v2.bundle import (
    DEFAULT_HOST_VERSION,
    DEFAULT_PYTHON_REQUIRES,
    inspect_platform_bundle,
)
from app.plugin_installer_v2.errors import PlatformInstallerBaseError

from .assessment import assess_github_repository, write_assessment
from .build import build_reviewed_adapter_bundle, validate_adapter_source
from .errors import GitHubImportError
from .models import ADAPTER_TEMPLATE_KINDS, GitHubPin
from .scaffold import scaffold_adapter


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="candlescope-plugin v3",
        description=(
            "Assess pinned public GitHub metadata, generate non-executable Adapter scaffolds, "
            "and package only human-completed schema-v3 sources."
        ),
    )
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--host-version", default=DEFAULT_HOST_VERSION)
    commands = parser.add_subparsers(dest="command", required=True)

    assess = commands.add_parser(
        "assess-github",
        help="read fixed GitHub metadata without cloning, downloading assets, or executing code",
    )
    assess.add_argument("repository_url")
    pin = assess.add_mutually_exclusive_group(required=True)
    pin.add_argument("--tag")
    pin.add_argument("--commit")
    assess.add_argument("--output", type=Path, required=True)
    assess.add_argument("--allow-network", action="store_true")
    assess.add_argument("--force", action="store_true")

    scaffold = commands.add_parser(
        "scaffold-adapter",
        help="atomically generate a pending, non-executable Adapter source layout",
    )
    scaffold.add_argument("template_kind", choices=ADAPTER_TEMPLATE_KINDS)
    scaffold.add_argument("--id", required=True, dest="plugin_id")
    scaffold.add_argument("--output", type=Path, required=True)
    scaffold.add_argument("--name")
    scaffold.add_argument("--publisher", default="local-developer")
    scaffold.add_argument("--license", default="GPL-3.0-only", dest="license_spdx")
    scaffold.add_argument("--assessment", type=Path)

    check = commands.add_parser(
        "source-lock-check",
        help="verify a human-completed source lock without building or executing it",
    )
    check.add_argument("source", type=Path)

    build = commands.add_parser(
        "build",
        help="validate a complete human source lock, then build a deterministic cspkg",
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
        "--arch",
        action="append",
        choices=("x86_64", "arm64"),
        dest="architectures",
    )
    build.add_argument("--force", action="store_true")

    inspect = commands.add_parser(
        "inspect",
        help="strictly inspect a local schema-v2 or schema-v3 cspkg without installing it",
    )
    inspect.add_argument("bundle", type=Path)
    return parser


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "assess-github":
        pin = GitHubPin("tag", args.tag) if args.tag is not None else GitHubPin("commit", args.commit)
        assessment = assess_github_repository(
            args.repository_url,
            pin,
            allow_network=args.allow_network,
        )
        markdown_path, evidence_path = write_assessment(
            assessment,
            args.output,
            force=args.force,
        )
        return {
            "ok": True,
            "assessment": {
                "repository": assessment["repository"]["url"],
                "commit": assessment["resolvedPin"]["commitSha"],
                "assessmentSha256": assessment["assessmentSha256"],
                "decision": assessment["decision"],
                "markdown": str(markdown_path),
                "evidence": str(evidence_path),
            },
        }
    if args.command == "scaffold-adapter":
        result = scaffold_adapter(
            args.template_kind,
            args.plugin_id,
            args.output,
            name=args.name,
            publisher=args.publisher,
            license_spdx=args.license_spdx,
            assessment_path=args.assessment,
        )
        return {"ok": True, "scaffold": result.to_wire()}
    if args.command == "source-lock-check":
        return {"ok": True, "sourceLock": validate_adapter_source(args.source).to_wire()}
    if args.command == "build":
        validated, bundle = build_reviewed_adapter_bundle(
            args.source,
            args.output,
            python_requires=args.python_requires,
            operating_systems=tuple(sorted(args.operating_systems or ("windows",))),
            architectures=tuple(sorted(args.architectures or ("x86_64",))),
            host_version=args.host_version,
            force=args.force,
        )
        return {
            "ok": True,
            "sourceLock": validated.to_wire(),
            "bundle": bundle.to_wire(),
        }
    if args.command == "inspect":
        return {
            "ok": True,
            "bundle": inspect_platform_bundle(
                args.bundle,
                host_version=args.host_version,
            ).to_wire(),
        }
    raise GitHubImportError(
        "PLUGIN_GITHUB_IMPORT_COMMAND_UNSUPPORTED",
        "v3 command is unsupported",
    )


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
    except GitHubImportError as exc:
        _emit({"ok": False, "error": exc.to_dict()}, compact=args.as_json, stream=sys.stderr)
        return 1
    except PlatformInstallerBaseError as exc:
        _emit({"ok": False, "error": exc.to_dict()}, compact=args.as_json, stream=sys.stderr)
        return 1
    except PlatformContractError as exc:
        _emit(
            {
                "ok": False,
                "error": {
                    "code": "PLUGIN_ADAPTER_CONTRACT_INVALID",
                    "message": str(exc),
                    "details": {"contractCode": exc.code, "path": exc.path},
                },
            },
            compact=args.as_json,
            stream=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        _emit(
            {
                "ok": False,
                "error": {
                    "code": "PLUGIN_GITHUB_IMPORT_INTERRUPTED",
                    "message": "GitHub Adapter operation was interrupted",
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
