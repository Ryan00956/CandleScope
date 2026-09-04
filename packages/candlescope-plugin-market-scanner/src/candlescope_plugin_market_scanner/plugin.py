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


_CONTRACT_LOCALIZATIONS = {
    "zh-CN": {
        "market scanner accepts only an empty scan command": "市场扫描器只接受空参数扫描命令",
        "market scanner completion token is stale": "市场扫描器完成令牌已失效",
        "Host returned invalid scanner settings": "宿主返回的扫描器设置无效",
        "Host returned an invalid symbol page": "宿主返回的标的页面无效",
        "market scanner phase is invalid": "市场扫描器阶段无效",
        "capabilityUnavailable": "{permission} 能力不可用",
    },
    "ko": {
        "market scanner accepts only an empty scan command": "시장 스캐너는 빈 인자 스캔 명령만 허용",
        "market scanner completion token is stale": "시장 스캐너 완료 토큰이 만료됨",
        "Host returned invalid scanner settings": "호스트가 반환한 스캐너 설정이 유효하지 않음",
        "Host returned an invalid symbol page": "호스트가 반환한 종목 페이지가 유효하지 않음",
        "market scanner phase is invalid": "시장 스캐너 단계가 유효하지 않음",
        "capabilityUnavailable": "{permission} 기능을 사용할 수 없음",
    },
}


def _localized_contract_error(error: PlatformContractError, locale: str | None) -> PlatformContractError:
    candidate = (locale or "").strip().lower()
    messages = None
    while candidate:
        messages = next(
            (value for key, value in _CONTRACT_LOCALIZATIONS.items() if key.lower() == candidate),
            None,
        )
        if messages is not None:
            break
        candidate = candidate.rpartition("-")[0]
    if messages is None:
        return error
    message = messages.get(error.message)
    if message is None and error.message.endswith(" capability is unavailable"):
        permission = error.message.removesuffix(" capability is unavailable")
        template = messages.get("capabilityUnavailable")
        if template is not None:
            message = template.replace("{permission}", permission)
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
