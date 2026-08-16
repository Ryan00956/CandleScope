#!/usr/bin/env python3
"""Phase 9 GitHub assessment/scaffold and real second-Adapter release gate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
CLI_PATH = BACKEND_ROOT / "scripts" / "candlescope_plugin.py"
CONTRACT_PATH = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "phase9_contract_v2.json"
)
ASSESSMENT_PATH = (
    REPOSITORY_ROOT / "docs" / "plugin-adapters" / "aho-corasick-assessment.json"
)
ADAPTER_ROOT = REPOSITORY_ROOT / "examples" / "plugins" / "aho-corasick-adapter"
BUILD_SCRIPT = ADAPTER_ROOT / "scripts" / "build_release.py"
MANIFEST_PATH = ADAPTER_ROOT / "manifest.json"
SOURCE_LOCK_PATH = ADAPTER_ROOT / "source-lock.json"
SUPPLY_LOCK_PATH = ADAPTER_ROOT / "supply-chain.lock.json"
TRANSCRIPT_PATH = ADAPTER_ROOT / "conformance" / "control-transcript.json"
BUILD_REPORT_PATH = ADAPTER_ROOT / "evidence" / "build-report.json"
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase9-gate/1"
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase9-contract/2"
EXPECTED_BUNDLE_SHA256 = (
    "sha256:7c507284903053e9c45e4acb3766e34c101e70d247c62760c071a98ea7b9a67d"
)
TEMPLATE_KINDS = [
    "java-library",
    "native-cli",
    "node-library",
    "python-package",
    "sandbox-view",
    "service",
    "wasm-computation",
]


class Phase9GateError(RuntimeError):
    pass


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise Phase9GateError(f"JSON root is not an object: {path}")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return "sha256:" + value.hexdigest()


def _canonical_sha256(value: Any) -> str:
    return _sha256_bytes(
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def capture_contract() -> dict[str, Any]:
    assessment = _json(ASSESSMENT_PATH)
    manifest = _json(MANIFEST_PATH)
    supply = _json(SUPPLY_LOCK_PATH)
    transcript = _json(TRANSCRIPT_PATH)
    receipt = _json(ADAPTER_ROOT / "build-receipt.json")
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "lockMigratedOn": "2026-08-16",
        "previousContractSha256": (
            "sha256:e129fc40ee6d4a8eabfb6bb969d6aba226a50bbd10281eefb72c244f2a691df"
        ),
        "assessment": {
            "schemaVersion": assessment["schemaVersion"],
            "repository": assessment["repository"]["url"],
            "tag": assessment["resolvedPin"]["requested"],
            "tagObject": assessment["resolvedPin"]["annotatedTags"][0]["sha"],
            "commit": assessment["resolvedPin"]["commitSha"],
            "commitVerified": assessment["resolvedPin"]["commitVerification"][
                "verified"
            ],
            "assessmentIdentity": assessment["assessmentSha256"],
            "assessmentFileSha256": _sha256_path(ASSESSMENT_PATH),
            "releaseStatus": assessment["release"]["status"],
            "executedRepositoryCode": assessment["behavior"][
                "executedRepositoryCode"
            ],
            "mayExecute": assessment["decision"]["mayExecute"],
        },
        "helper": {
            "flag": "CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED",
            "defaultEnabled": False,
            "networkConfirmationRequired": True,
            "fixedApiOrigin": "https://api.github.com",
            "optionalTokenEnvironments": ["GITHUB_TOKEN", "GH_TOKEN"],
            "clone": False,
            "releaseAssetDownload": False,
            "repositoryWorkflowExecution": False,
            "installScriptExecution": False,
            "binaryExecution": False,
            "pendingSourceLockExecutable": False,
        },
        "scaffold": {
            "schemaVersion": "candlescope.adapter-scaffold/1",
            "templates": TEMPLATE_KINDS,
            "activeWorkflowGenerated": False,
            "hostInternalImportsAllowed": False,
            "atomicNewDirectoryOnly": True,
            "bundleDevelopmentTreeSeparated": True,
            "receiptBindsEveryPackageInput": True,
        },
        "referenceAdapter": {
            "pluginId": manifest["plugin"]["id"],
            "version": manifest["plugin"]["version"],
            "publisher": manifest["plugin"]["publisher"],
            "runtimeKind": manifest["backend"]["entrypoints"][0]["runtime"]["kind"],
            "runtimeArtifact": manifest["backend"]["entrypoints"][0]["runtime"][
                "artifact"
            ],
            "runtimeSha256": supply["releaseArtifact"]["sha256"],
            "runtimeSize": supply["releaseArtifact"]["size"],
            "target": supply["target"],
            "buildPath": supply["buildPath"],
            "rustc": supply["toolchain"]["rustc"],
            "cargo": supply["toolchain"]["cargo"],
            "upstreamCrates": [
                {
                    key: item[key]
                    for key in ("name", "version", "sha256", "size", "licenseSpdx")
                }
                for item in supply["dependencies"]
            ],
            "sourceCompilation": receipt["sourceCompilation"],
            "networkAccessDuringBuild": receipt["networkAccessDuringBuild"],
            "reproducibleBuilds": receipt["reproducibleBuilds"],
            "sourceLockSha256": _sha256_path(SOURCE_LOCK_PATH),
            "buildReceiptSha256": _sha256_path(ADAPTER_ROOT / "build-receipt.json"),
            "transcriptResponses": len(transcript["expected"]["responseSha256"]),
            "transcriptSha256": transcript["expected"]["transcriptSha256"],
            "bundleSha256": EXPECTED_BUNDLE_SHA256,
            "permissions": manifest["permissions"],
            "hostInternalImports": False,
            "upstreamAlgorithmCopied": False,
        },
        "exitGate": {
            "secondProject": "BurntSushi/aho-corasick",
            "assessmentToLocalInstall": True,
            "freshInstall": True,
            "quickRepeat": True,
            "freshProcessCheck": True,
            "disableEnable": True,
            "helperRollbackPreservesBundle": True,
            "nativeFlagOffFailsClosed": True,
        },
    }


def validate_contract() -> dict[str, Any]:
    fixture = _json(CONTRACT_PATH)
    current = capture_contract()
    if fixture != current:
        raise Phase9GateError(
            "Phase 9 contract drift: "
            f"fixture={_canonical_sha256(fixture)} current={_canonical_sha256(current)}"
        )
    return fixture


def _command_json(
    arguments: list[str],
    *,
    environment: dict[str, str],
    expected_exit: int = 0,
    timeout: int = 120,
) -> tuple[dict[str, Any], subprocess.CompletedProcess[str]]:
    completed = subprocess.run(
        arguments,
        cwd=REPOSITORY_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
    )
    if completed.returncode != expected_exit:
        raise Phase9GateError(
            f"command exited {completed.returncode}, expected {expected_exit}: "
            f"{' '.join(arguments)}\nstdout={completed.stdout}\nstderr={completed.stderr}"
        )
    payload_text = completed.stdout if expected_exit == 0 else completed.stderr
    try:
        value = json.loads(payload_text)
    except json.JSONDecodeError as exc:
        raise Phase9GateError(
            f"command did not return one JSON object: {' '.join(arguments)}"
        ) from exc
    if not isinstance(value, dict):
        raise Phase9GateError("command JSON root is not an object")
    return value, completed


def _environment(*, native: bool) -> dict[str, str]:
    environment = os.environ.copy()
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        environment.pop(name, None)
    environment.update(
        {
            "CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED": "0",
            "CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED": "1" if native else "0",
        }
    )
    return environment


def _v3(*arguments: str) -> list[str]:
    return [sys.executable, str(CLI_PATH), "v3", "--json", *arguments]


def _v2(root: Path, *arguments: str) -> list[str]:
    return [
        sys.executable,
        str(CLI_PATH),
        "v2",
        "--root",
        str(root),
        "--json",
        *arguments,
    ]


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    native_environment = _environment(native=True)
    disabled_environment = _environment(native=False)
    supply = _json(SUPPLY_LOCK_PATH)
    with tempfile.TemporaryDirectory(prefix="candlescope-phase9-gate-") as raw:
        temporary = Path(raw)
        rebuilt = temporary / "rebuilt-adapter.exe"
        rebuild_report = temporary / "rebuild-report.json"
        rebuild, rebuild_process = _command_json(
            [
                sys.executable,
                str(BUILD_SCRIPT),
                "--output",
                str(rebuilt),
                "--report",
                str(rebuild_report),
            ],
            environment=native_environment,
        )
        expected_runtime = supply["releaseArtifact"]
        if (
            rebuild["output"]["sha256"] != expected_runtime["sha256"]
            or rebuild["output"]["size"] != expected_runtime["size"]
            or _sha256_path(rebuilt) != expected_runtime["sha256"]
        ):
            raise Phase9GateError("offline double build did not reproduce the locked runtime")

        checked, _ = _command_json(
            _v3("source-lock-check", str(ADAPTER_ROOT)),
            environment=native_environment,
        )
        first_bundle = temporary / "aho-first.cspkg"
        second_bundle = temporary / "aho-second.cspkg"
        first, _ = _command_json(
            _v3(
                "build",
                str(ADAPTER_ROOT),
                str(first_bundle),
                "--os",
                "windows",
                "--arch",
                "x86_64",
            ),
            environment=native_environment,
        )
        second, _ = _command_json(
            _v3(
                "build",
                str(ADAPTER_ROOT),
                str(second_bundle),
                "--os",
                "windows",
                "--arch",
                "x86_64",
            ),
            environment=native_environment,
        )
        bundle_sha256 = first["bundle"]["sha256"]
        if (
            bundle_sha256 != second["bundle"]["sha256"]
            or _sha256_path(first_bundle) != bundle_sha256
            or first_bundle.read_bytes() != second_bundle.read_bytes()
            or bundle_sha256 != EXPECTED_BUNDLE_SHA256
        ):
            raise Phase9GateError("reviewed Adapter bundle is not byte-reproducible")
        inspected, _ = _command_json(
            _v3("inspect", str(first_bundle)),
            environment=native_environment,
        )

        assessment_output = temporary / "must-not-exist.md"
        helper_disabled, _ = _command_json(
            _v3(
                "assess-github",
                "https://github.com/BurntSushi/aho-corasick",
                "--tag",
                "1.1.4",
                "--output",
                str(assessment_output),
                "--allow-network",
            ),
            environment=native_environment,
            expected_exit=1,
        )
        if (
            helper_disabled["error"]["code"]
            != "PLUGIN_GITHUB_IMPORT_FEATURE_DISABLED"
            or assessment_output.exists()
            or assessment_output.with_suffix(".json").exists()
        ):
            raise Phase9GateError("disabled GitHub helper did not fail before output/network")

        disabled_root = temporary / "native-disabled"
        disabled_root.mkdir()
        native_disabled, _ = _command_json(
            _v2(
                disabled_root,
                "install",
                str(first_bundle),
                "--sha256",
                bundle_sha256,
                "--enable",
            ),
            environment=disabled_environment,
            expected_exit=1,
        )
        if native_disabled["error"]["code"] != "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE":
            raise Phase9GateError("native Provider flag-off error changed")

        install_root = temporary / "installation"
        install_root.mkdir()
        installed, _ = _command_json(
            _v2(
                install_root,
                "install",
                str(first_bundle),
                "--sha256",
                bundle_sha256,
                "--enable",
            ),
            environment=native_environment,
        )
        repeated, _ = _command_json(
            _v2(
                install_root,
                "install",
                str(first_bundle),
                "--sha256",
                bundle_sha256,
                "--enable",
            ),
            environment=native_environment,
        )
        checked_runtime, _ = _command_json(
            _v2(install_root, "check", "candlescope.aho-corasick"),
            environment=native_environment,
        )
        disabled, _ = _command_json(
            _v2(install_root, "disable", "candlescope.aho-corasick"),
            environment=native_environment,
        )
        enabled, _ = _command_json(
            _v2(install_root, "enable", "candlescope.aho-corasick"),
            environment=native_environment,
        )
        helper_rollback_check, _ = _command_json(
            _v2(install_root, "check", "candlescope.aho-corasick"),
            environment=native_environment,
        )
        listed, _ = _command_json(
            _v2(install_root, "list"),
            environment=native_environment,
        )
        uninstalled, _ = _command_json(
            _v2(install_root, "uninstall", "candlescope.aho-corasick"),
            environment=native_environment,
        )
        empty, _ = _command_json(
            _v2(install_root, "list"),
            environment=native_environment,
        )

        semantic = checked_runtime["check"]["freshProcessProbe"]["semanticProbes"]
        if (
            installed["installation"]["changed"] is not True
            or installed["installation"]["reusedInstallation"] is not False
            or repeated["installation"]["changed"] is not False
            or repeated["installation"]["reusedInstallation"] is not True
            or checked_runtime["check"]["state"] != "active"
            or semantic[0]["sha256"]
            != contract["referenceAdapter"]["transcriptSha256"]
            or disabled["change"]["state"] != "disabled"
            or enabled["change"]["state"] != "active"
            or helper_rollback_check["check"]["state"] != "active"
            or len(listed["plugins"]) != 1
            or uninstalled["change"]["changed"] is not True
            or uninstalled["change"]["state"] is not None
            or empty["plugins"]
        ):
            raise Phase9GateError("fresh install/check/disable/enable/uninstall gate failed")

    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _canonical_sha256(contract),
        "environment": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "rustc": supply["toolchain"]["rustc"],
            "cargo": supply["toolchain"]["cargo"],
        },
        "assessment": {
            "repository": contract["assessment"]["repository"],
            "tag": contract["assessment"]["tag"],
            "commit": contract["assessment"]["commit"],
            "assessmentIdentity": contract["assessment"]["assessmentIdentity"],
            "helperDisabledError": helper_disabled["error"]["code"],
            "partialOutput": False,
        },
        "build": {
            "networkAccessDuringBuild": rebuild["networkAccessDuringBuild"],
            "reproducibleBuilds": rebuild["reproducibleBuilds"],
            "buildPath": rebuild["buildPath"],
            "runtimeSha256": rebuild["output"]["sha256"],
            "runtimeSize": rebuild["output"]["size"],
            "compilerLogSha256": _sha256_bytes(rebuild_process.stderr.encode("utf-8")),
            "sourceLockSha256": checked["sourceLock"]["sourceLockSha256"],
            "bundleSha256": bundle_sha256,
            "bundleSize": first["bundle"]["size"],
            "bundleRepeatIdentical": True,
            "inspectPluginId": inspected["bundle"]["manifest"]["plugin"]["id"],
        },
        "installation": {
            "pluginId": installed["installation"]["pluginId"],
            "runtimeKind": listed["plugins"][0]["entrypoints"][0]["runtimeKind"],
            "runtimeId": listed["plugins"][0]["entrypoints"][0]["runtimeId"],
            "freshInstall": True,
            "quickRepeat": True,
            "freshProcessCheck": checked_runtime["check"]["state"],
            "semanticProbeSha256": semantic[0]["sha256"],
            "disableEnable": True,
            "helperFlagRollbackCheck": helper_rollback_check["check"]["state"],
            "nativeFlagOffError": native_disabled["error"]["code"],
            "uninstall": uninstalled["change"]["changed"],
            "finalRegistryEmpty": not empty["plugins"],
        },
    }


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--write-contract", action="store_true")
    parser.add_argument("--run-gate", action="store_true")
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args(argv)
    if arguments.run_gate:
        value = run_gate()
    else:
        value = capture_contract()
    if arguments.write_contract:
        _atomic_write(CONTRACT_PATH, value)
    if arguments.output is not None:
        _atomic_write(arguments.output, value)
    if arguments.print_contract or arguments.run_gate or arguments.output is None:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
