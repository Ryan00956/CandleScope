from __future__ import annotations

import copy

import jsonschema
import pytest

from candlescope_plugin_sdk.platform_v2 import (
    DEFAULT_MAX_UI_BRIDGE_MESSAGE_BYTES,
    UI_BRIDGE_V1,
    InvokeRequest,
    PlatformContractError,
    RequestContext,
    manifest_schema,
)
from candlescope_plugin_sdk.platform_v2.examples.sandbox_view import (
    SandboxViewPlugin,
    sandbox_view_manifest,
)


def test_sandbox_view_reference_is_descriptor_only_and_capability_free() -> None:
    plugin = SandboxViewPlugin()
    manifest = sandbox_view_manifest()
    assert UI_BRIDGE_V1 == "candlescope.ui-bridge/1"
    assert DEFAULT_MAX_UI_BRIDGE_MESSAGE_BYTES == 32 * 1024
    assert manifest.permissions.required == ()
    assert manifest.permissions.optional == ()
    assert manifest.frontend is not None
    jsonschema.validate(manifest.to_wire(), manifest_schema())
    assert [item.to_wire() for item in manifest.frontend.surfaces] == [
        {
            "id": "main-view",
            "type": "sandbox",
            "entry": "index.html",
            "slot": "side-panel",
        }
    ]
    manifest.validate_descriptor(plugin.describe())
    assert plugin.health_check() == {"status": "ready", "backendCapabilities": 0}
    with pytest.raises(PlatformContractError, match="no invokable"):
        plugin.invoke(
            InvokeRequest(
                "main-view",
                {},
                RequestContext("main-view", True, 1, "sandbox-view-test"),
            )
        )

    invalid = copy.deepcopy(manifest.to_wire())
    invalid["frontend"]["surfaces"][0]["slot"] = "statusArea"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(invalid, manifest_schema())
    with pytest.raises(PlatformContractError, match="local identifier"):
        type(manifest).from_wire(invalid)
