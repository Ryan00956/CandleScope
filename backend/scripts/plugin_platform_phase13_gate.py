"""Run the bounded Phase 13 v1-compatibility and rollback release gate.

The gate works only in a temporary product root. It verifies the frozen Phase
0 wire hashes, performs two explicit compatibility imports, rolls back the
second import, and proves that a disabled v2 facade still serves the unchanged
v1 Indicator catalog.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import platform
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
REFERENCE_PLUGINS = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_v2"
    / "reference_plugins_v1.json"
)
SCHEMA_VERSION = "candlescope.plugin-platform.phase13-gate/1"


def _ensure_import_paths() -> None:
    for path in (str(BACKEND_ROOT), str(SDK_SOURCE)):
        if path not in sys.path:
            sys.path.insert(0, path)


def _git_head() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _reference_contract() -> dict[str, Any]:
    value = json.loads(REFERENCE_PLUGINS.read_text(encoding="utf-8"))
    reference = next(
        item
        for item in value["plugins"]
        if item["id"] == "phase0.v1-script-runtime-adapter"
    )
    if (
        reference["firstTargetPhase"] != 13
        or reference["contributions"] != ["script-runtime/1"]
        or reference["requiredCapabilities"] != []
        or "trade.submit" not in reference["forbiddenCapabilities"]
    ):
        raise RuntimeError("Phase 13 v1 adapter reference contract drifted")
    return {
        "id": reference["id"],
        "contributions": reference["contributions"],
        "requiredCapabilities": reference["requiredCapabilities"],
        "forbiddenCapabilities": reference["forbiddenCapabilities"],
        "acceptanceCount": len(reference["acceptance"]),
    }


async def _exercise(root: Path) -> dict[str, Any]:
    _ensure_import_paths()

    from candlescope_plugin_sdk import (
        FEATURE_BATCH_EXECUTION_V1,
        FEATURE_RENDER_LINE_SERIES_V1,
        LanguageDescriptor,
        RuntimeDescriptor,
    )
    from candlescope_plugin_sdk.platform_v2 import canonical_dumps

    from app.indicator.runtime_routes import (
        IndicatorRuntimeRoute,
        IndicatorRuntimeRoutes,
    )
    from app.indicator.runtime_service import IndicatorRuntimeService
    from app.plugin_compat_v1 import V1ScriptRuntimeCompatibilityBridge
    from app.plugin_core_v2.runtime import DisabledCorePluginPlatform
    from app.plugin_runtime import (
        ManagedRuntimeIdentity,
        RuntimeHostService,
        RuntimeProcessSpec,
        RuntimeRegistry,
    )
    from scripts.plugin_platform_phase0_baseline import frozen_contracts

    class DescriptorHost:
        def __init__(self, version: str) -> None:
            self.version = version

        async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
            if runtime_id != "candlescope.pyne":
                raise RuntimeError("unexpected Phase 13 runtime id")
            return RuntimeDescriptor(
                id=runtime_id,
                name="Pyne Runtime",
                version=self.version,
                package="candlescope-plugin-pyne",
                languages=(LanguageDescriptor(id="pyne", name="Pyne"),),
                features=(
                    FEATURE_BATCH_EXECUTION_V1,
                    FEATURE_RENDER_LINE_SERIES_V1,
                ),
                required_host_features=(),
            )

        async def execute_batch(self, runtime_id: str, request: object) -> object:
            raise RuntimeError("Phase 13 catalog gate must not execute a runtime")

    def runtime_host(version: str, bundle_digit: str) -> RuntimeHostService:
        return RuntimeHostService(
            RuntimeRegistry(
                (
                    RuntimeProcessSpec(
                        runtime_id="candlescope.pyne",
                        expected_package="candlescope-plugin-pyne",
                        expected_version=version,
                        executable=Path(sys.executable).resolve(),
                        enabled=True,
                        auto_start=False,
                        managed=ManagedRuntimeIdentity(
                            installation_id=bundle_digit * 64,
                            activation_id=bundle_digit * 32,
                            bundle_sha256=f"sha256:{bundle_digit * 64}",
                        ),
                    ),
                )
            ),
            host_name="CandleScope",
            host_version="0.4.0",
        )

    async def bridge_for(
        version: str,
        bundle_digit: str,
    ) -> tuple[
        V1ScriptRuntimeCompatibilityBridge,
        IndicatorRuntimeService,
    ]:
        indicator = IndicatorRuntimeService(
            IndicatorRuntimeRoutes(
                (
                    IndicatorRuntimeRoute(
                        language="pyne",
                        mode="sidecar",
                        runtime_id="candlescope.pyne",
                    ),
                )
            ),
            host=DescriptorHost(version),
        )
        await indicator.start()
        bridge = V1ScriptRuntimeCompatibilityBridge(
            root=root,
            indicator_source=indicator,
            runtime_host=runtime_host(version, bundle_digit),
        )
        indicator.bind_catalog_projector(bridge.project_indicator_catalog)
        return bridge, indicator

    release_one, indicator_one = await bridge_for("1.0.0", "a")
    v1_wire_one = indicator_one.compatibility_source_catalog()
    if await indicator_one.public_catalog() != v1_wire_one:
        raise RuntimeError("release-one v1 catalog changed during unified projection")
    preview_one = release_one.import_preview()
    import_one = release_one.apply_import(preview_one["previewSha256"])
    if import_one["compatibility"]["import"]["status"] != "current":
        raise RuntimeError("release-one compatibility import did not become current")

    release_two, indicator_two = await bridge_for("1.1.0", "b")
    v1_wire_two = indicator_two.compatibility_source_catalog()
    preview_two = release_two.import_preview()
    if preview_two["changes"] != [
        {"id": "compat.v1.candlescope.pyne", "action": "update"}
    ]:
        raise RuntimeError("release-two compatibility diff is not an exact update")
    import_two = release_two.apply_import(preview_two["previewSha256"])
    rollback_preview = release_two.rollback_preview()
    rollback = release_two.apply_rollback(rollback_preview["previewSha256"])
    if rollback["compatibility"]["import"]["status"] != "stale":
        raise RuntimeError("rollback did not restore the prior compatibility snapshot")

    v1_only = DisabledCorePluginPlatform()
    v1_only.bind_v1_compatibility(release_two)
    v1_only_catalog = v1_only.catalog()
    if (
        v1_only_catalog["platform"]["status"] != "disabled"
        or v1_only_catalog["plugins"] != []
        or await indicator_two.public_catalog() != v1_wire_two
    ):
        raise RuntimeError("v1-only rollback facade changed the v1 product behavior")

    frozen = frozen_contracts()
    return {
        "referenceContract": _reference_contract(),
        "frozenV1Contracts": frozen,
        "releaseOne": {
            "previewSha256": preview_one["previewSha256"],
            "sourceSha256": import_one["compatibility"]["import"]["sourceSha256"],
            "bundleSha256": "sha256:" + "a" * 64,
            "wireCanonicalSha256": "sha256:"
            + hashlib.sha256(canonical_dumps(v1_wire_one).encode("utf-8")).hexdigest(),
        },
        "releaseTwo": {
            "previewSha256": preview_two["previewSha256"],
            "sourceSha256": import_two["compatibility"]["import"]["sourceSha256"],
            "bundleSha256": "sha256:" + "b" * 64,
            "wireCanonicalSha256": "sha256:"
            + hashlib.sha256(canonical_dumps(v1_wire_two).encode("utf-8")).hexdigest(),
        },
        "rollback": {
            "previewSha256": rollback_preview["previewSha256"],
            "restoredSnapshotRevision": rollback_preview["targetSnapshotRevision"],
            "statusAgainstLiveReleaseTwo": rollback["compatibility"]["import"][
                "status"
            ],
            "v1OnlyPlatformStatus": v1_only_catalog["platform"]["status"],
            "v1OnlyPluginCount": len(v1_only_catalog["plugins"]),
            "v1WireUnchanged": True,
        },
    }


def run_gate() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="candlescope-phase13-gate-") as raw:
        evidence = asyncio.run(_exercise(Path(raw)))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": datetime.now(UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "gitHead": _git_head(),
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        **evidence,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the bounded Plugin Platform Phase 13 compatibility gate."
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional machine-readable evidence path.",
    )
    args = parser.parse_args(argv)
    result = run_gate()
    payload = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        output = args.output.expanduser().resolve(strict=False)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
