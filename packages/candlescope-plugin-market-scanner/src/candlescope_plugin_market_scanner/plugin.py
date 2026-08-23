"""Distribution-owned wrapper around the SDK Market Scanner reference kernel."""

from __future__ import annotations

from importlib.resources import files

from candlescope_plugin_sdk.platform_v2 import InvokeRequest, PluginManifest
from candlescope_plugin_sdk.platform_v2.errors import PlatformContractError
from candlescope_plugin_sdk.platform_v2.examples.market_scanner import (
    MarketScannerPlugin as ReferenceMarketScannerPlugin,
)
from candlescope_plugin_sdk.platform_v2.json_codec import loads_strict
from candlescope_plugin_sdk.platform_v2.server import serve_platform_plugin


def market_scanner_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


_ZH_CONTRACT_MESSAGES = {
    "market scanner accepts only an empty scan command": "市场扫描器只接受空参数扫描命令",
    "market scanner completion token is stale": "市场扫描器完成令牌已失效",
    "Host returned invalid scanner settings": "宿主返回的扫描器设置无效",
    "Host returned an invalid symbol page": "宿主返回的标的页面无效",
    "market scanner phase is invalid": "市场扫描器阶段无效",
}


def _localized_contract_error(error: PlatformContractError, locale: str | None) -> PlatformContractError:
    if locale != "zh-CN":
        return error
    message = _ZH_CONTRACT_MESSAGES.get(error.message)
    if message is None and error.message.endswith(" capability is unavailable"):
        permission = error.message.removesuffix(" capability is unavailable")
        message = f"{permission} 能力不可用"
    if message is None:
        return error
    return PlatformContractError(error.code, message, error.path)


class MarketScannerPlugin(ReferenceMarketScannerPlugin):
    """The packaged scanner owns its manifest and locale-aware validation errors."""

    def __init__(self) -> None:
        super().__init__()
        self._manifest = market_scanner_manifest()

    def invoke(self, request: InvokeRequest):  # type: ignore[no-untyped-def]
        try:
            return super().invoke(request)
        except PlatformContractError as error:
            raise _localized_contract_error(error, request.request_context.locale) from error

    def complete_host_call(self, token, response):  # type: ignore[no-untyped-def]
        state = self._pending.get(token)
        locale = state.context.locale if state is not None else None
        try:
            return super().complete_host_call(token, response)
        except PlatformContractError as error:
            raise _localized_contract_error(error, locale) from error


def main() -> int:
    return serve_platform_plugin(MarketScannerPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
