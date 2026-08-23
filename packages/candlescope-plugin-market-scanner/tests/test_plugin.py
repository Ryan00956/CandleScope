from __future__ import annotations

import pytest
from candlescope_plugin_sdk.platform_v2 import (
    ActivationRequest,
    CapabilityGrant,
    HostCallInvocation,
    InvokeRequest,
    RequestContext,
)
from candlescope_plugin_sdk.platform_v2.errors import PlatformContractError

from candlescope_plugin_market_scanner import MarketScannerPlugin, market_scanner_manifest


def _context(locale: str = "en") -> RequestContext:
    return RequestContext(
        contribution_id="scan",
        user_action=True,
        generation=1,
        trace_id="market-scanner-test",
        locale=locale,
    )


def test_packaged_manifest_owns_entrypoint_and_localized_enum_labels() -> None:
    manifest = market_scanner_manifest()
    assert manifest.plugin.id == "candlescope.market-scanner"
    assert manifest.backend_entrypoints[0].python_module == "candlescope_plugin_market_scanner"
    settings = next(item for item in manifest.contributions if item.id == "settings")
    interval = settings.localizations["zh-CN"]["schema"]["properties"]["interval"]
    assert interval["enumLabels"] == ["1 分钟", "5 分钟", "1 小时"]


def test_scan_preserves_invocation_locale_on_host_calls() -> None:
    plugin = MarketScannerPlugin()
    manifest = plugin.manifest()
    permissions = tuple(
        CapabilityGrant(handle=f"cap-{index}", permission_id=permission.id)
        for index, permission in enumerate(manifest.permissions.required)
    )
    plugin.activate(ActivationRequest(instance_id="test", generation=1, capabilities=permissions))
    outcome = plugin.invoke(
        InvokeRequest(contribution_id="scan", input={}, request_context=_context("zh-CN"))
    )
    assert isinstance(outcome, HostCallInvocation)
    assert outcome.call.request_context.locale == "zh-CN"


def test_plugin_owned_validation_error_follows_request_locale() -> None:
    plugin = MarketScannerPlugin()
    request = InvokeRequest(
        contribution_id="scan",
        input={"unexpected": True},
        request_context=_context("zh-CN"),
    )
    with pytest.raises(PlatformContractError, match="只接受空参数"):
        plugin.invoke(request)
