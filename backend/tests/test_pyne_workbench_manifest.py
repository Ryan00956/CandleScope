from __future__ import annotations

import json
from pathlib import Path

from app.plugin_core_v2.contracts import core_contributions
from candlescope_plugin_sdk.platform_v2 import PluginManifest


MANIFEST = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-plugin-pyne-workbench"
    / "src"
    / "candlescope_plugin_pyne_workbench"
    / "manifest.json"
)


def test_pyne_workbench_manifest_passes_product_core_contracts() -> None:
    manifest = PluginManifest.from_wire(json.loads(MANIFEST.read_text(encoding="utf-8")))
    contributions = core_contributions(manifest)

    assert manifest.plugin.id == "candlescope.pyne-workbench"
    assert [(item.id, item.kind) for item in contributions] == [
        ("run", "command/1"),
        ("start-session", "command/1"),
        ("push-bar", "command/1"),
        ("snapshot-session", "command/1"),
        ("close-session", "command/1"),
        ("workbench-view", "view/1"),
        ("pyne-output", "chart-layer/2"),
    ]
    assert all(item.kind != "script-runtime/1" for item in contributions)
