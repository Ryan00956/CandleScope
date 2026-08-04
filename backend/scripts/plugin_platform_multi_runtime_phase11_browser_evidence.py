#!/usr/bin/env python3
"""Finalize headed production-build Plugin Manager evidence for Phase 11."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT / "docs/evidence/plugin-platform-multi-runtime-phase11-browser.json"
)
SCHEMA = "candlescope.plugin-platform.multi-runtime.phase11-browser/1"


class BrowserEvidenceError(RuntimeError):
    pass


def _strict_json(path: Path) -> dict[str, Any]:
    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number: {value}")

    if path.is_symlink() or not path.is_file():
        raise BrowserEvidenceError(f"required browser receipt is missing: {path}")
    value = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise BrowserEvidenceError(f"browser receipt is not an object: {path}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _artifact(path: Path) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    if resolved.stat().st_size <= 0:
        raise BrowserEvidenceError(f"browser artifact is empty: {resolved.name}")
    return {
        "name": resolved.name,
        "sha256": _sha256(resolved),
        "size": resolved.stat().st_size,
    }


def _git_head() -> str:
    return subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def finalize(args: argparse.Namespace) -> dict[str, Any]:
    live = _strict_json(args.live.resolve(strict=True))
    shutdown = _strict_json(args.shutdown.resolve(strict=True))
    if (
        live.get("schemaVersion")
        != "candlescope.plugin-platform.multi-runtime.phase11-browser-live/1"
        or live.get("result") != "pass"
    ):
        raise BrowserEvidenceError("live browser receipt did not pass")
    if (
        shutdown.get("schemaVersion")
        != "candlescope.plugin-platform.multi-runtime.phase11-browser-shutdown/1"
        or shutdown.get("result") != "pass"
        or shutdown.get("residualProcesses") != []
        or shutdown.get("residualSupervisors") != 0
    ):
        raise BrowserEvidenceError("browser fixture cleanup did not converge")
    browser = live.get("browser", {})
    flows = live.get("flows", {})
    marketplace = flows.get("marketplace", {})
    trusted_local = flows.get("trustedLocal", {})
    unexpected = live.get("http", {}).get("unexpected", [])
    if (
        browser.get("consoleErrors") != 0
        or browser.get("pageErrors") != 0
        or browser.get("unhandledRejections") != 0
        or not all(
            browser.get(key) is True
            for key in (
                "pluginManager",
                "marketplaceAssurances",
                "marketplaceInstalled",
                "trustedLocalInstalled",
            )
        )
        or unexpected != []
    ):
        raise BrowserEvidenceError(
            "browser observation contains an error or missing UI proof"
        )
    if (
        marketplace.get("trustMode") != "marketplace-sandboxed"
        or marketplace.get("sandboxStatus") != "windows-appcontainer"
        or marketplace.get("appContainerSidPresent") is not True
        or marketplace.get("activeProcessLimit") != 1
        or marketplace.get("processTreeControl") is not True
        or trusted_local.get("trustMode") != "trusted-local"
        or trusted_local.get("runtimeKind") != "native-executable"
        or trusted_local.get("doubleConfirmation") is not True
        or trusted_local.get("sandboxPolicy") is not None
        or flows.get("activeProcesses") != 2
        or flows.get("activeSupervisors") != 2
    ):
        raise BrowserEvidenceError(
            "Marketplace or trusted-local process proof is incomplete"
        )
    result = {
        "schemaVersion": SCHEMA,
        "result": "pass",
        "generatedAt": datetime.now(UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "gitHead": _git_head(),
        "headed": True,
        "productionBuild": True,
        "pluginManager": True,
        "consoleErrors": browser["consoleErrors"],
        "pageErrors": browser["pageErrors"],
        "unhandledRejections": browser["unhandledRejections"],
        "unexpectedHttp": len(unexpected),
        "flows": flows,
        "httpRequestCount": live["http"]["requestCount"],
        "cleanup": {
            "observedProcesses": shutdown["observedProcesses"],
            "observedSandboxProfiles": shutdown["observedSandboxProfiles"],
            "profilesDeleted": shutdown["profilesDeleted"],
            "residualProcesses": len(shutdown["residualProcesses"]),
            "residualSupervisors": shutdown["residualSupervisors"],
        },
        "artifacts": {
            "screenshot": _artifact(args.screenshot),
            "trace": _artifact(args.trace),
            "liveReceipt": _artifact(args.live),
            "shutdownReceipt": _artifact(args.shutdown),
        },
    }
    _atomic_json(args.output.resolve(strict=False), result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", type=Path, required=True)
    parser.add_argument("--shutdown", type=Path, required=True)
    parser.add_argument("--screenshot", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    result = finalize(parser.parse_args())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrowserEvidenceError, OSError, ValueError) as exc:
        print(
            json.dumps(
                {"ok": False, "errorType": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=__import__("sys").stderr,
        )
        raise SystemExit(1) from exc
