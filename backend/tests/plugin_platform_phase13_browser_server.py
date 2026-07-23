"""Production-frontend fixture for the Phase 13 v1 compatibility manager."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from app.plugin_compat_v1 import V1ScriptRuntimeCompatibilityBridge
from app.plugin_runtime import (
    ManagedRuntimeIdentity,
    RuntimeHostService,
    RuntimeProcessSpec,
    RuntimeRegistry,
)
from tests import plugin_platform_phase12_browser_server as phase12


class BrowserIndicatorCatalog:
    def compatibility_source_catalog(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "defaultLanguage": "pyne",
            "languages": [
                {
                    "id": "pyne",
                    "name": "Pyne",
                    "extensions": [".pyne"],
                    "aliases": ["python"],
                    "runtimeId": "candlescope.pyne",
                    "routeMode": "sidecar",
                    "available": True,
                    "features": [
                        "batch-execution/1",
                        "render.line-series/1",
                    ],
                }
            ],
            "runtimes": [
                {
                    "id": "candlescope.pyne",
                    "name": "Pyne Runtime",
                    "version": "0.2.0",
                    "package": "candlescope-plugin-pyne",
                    "languages": [
                        {
                            "id": "pyne",
                            "name": "Pyne",
                            "extensions": [".pyne"],
                            "aliases": ["python"],
                        }
                    ],
                    "features": [
                        "batch-execution/1",
                        "render.line-series/1",
                    ],
                    "requiredHostFeatures": [],
                    "meta": {},
                }
            ],
        }


RUNTIME_HOST = RuntimeHostService(
    RuntimeRegistry(
        (
            RuntimeProcessSpec(
                runtime_id="candlescope.pyne",
                expected_package="candlescope-plugin-pyne",
                expected_version="0.2.0",
                executable=Path(sys.executable).resolve(),
                enabled=True,
                auto_start=False,
                managed=ManagedRuntimeIdentity(
                    installation_id="d" * 64,
                    activation_id="e" * 32,
                    bundle_sha256="sha256:" + "f" * 64,
                ),
            ),
        )
    ),
    host_name="CandleScope",
    host_version="0.4.0",
)
COMPATIBILITY = V1ScriptRuntimeCompatibilityBridge(
    root=phase12.ROOT,
    indicator_source=BrowserIndicatorCatalog(),
    runtime_host=RUNTIME_HOST,
)
phase12.PLATFORM.bind_v1_compatibility(COMPATIBILITY)

app = phase12.app
