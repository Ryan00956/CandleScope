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
from candlescope_plugin_market_scanner.plugin import (
    _CONTRACT_LOCALIZATIONS,
    _localized_contract_error,
)


def test_plugin_error_localizations_accept_additional_languages_and_preserve_fallback(monkeypatch):
    error = PlatformContractError("invalid_request", "market scanner phase is invalid", "phase")
    assert _localized_contract_error(error, "ja") is error
    translated = _localized_contract_error(error, "fr-CA")
    assert translated.message == "La phase du scanner de marché est invalide"
    assert (translated.code, translated.path) == (error.code, error.path)
    capability = PlatformContractError("unavailable", "market.bars.read capability is unavailable")
    assert _localized_contract_error(capability, "fr").message == (
        "Capacité market.bars.read indisponible"
    )
    assert _localized_contract_error(error, "zh-cn").message == "市场扫描器阶段无效"
    monkeypatch.setitem(_CONTRACT_LOCALIZATIONS, "de", {
        "market scanner phase is invalid": "Ungültige Phase",
        "capabilityUnavailable": "Fähigkeit nicht verfügbar: {permission}",
    })
    german = _localized_contract_error(error, "de-DE")
    assert german.message == "Ungültige Phase"


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
    es_interval = settings.localizations["es"]["schema"]["properties"]["interval"]
    assert es_interval["enumLabels"] == ["1 minuto", "5 minutos", "1 hora"]
    assert len(es_interval["enumLabels"]) == len(
        settings.configuration["schema"]["properties"]["interval"]["enum"]
    )
    scan = next(item for item in manifest.contributions if item.id == "scan")
    assert scan.localizations["es"]["title"] == "Escanear mercados autorizados"
    results = next(item for item in manifest.contributions if item.id == "results")
    es_results = results.localizations["es"]
    assert es_results["title"] == "Resultados del escáner de mercado"
    assert set(es_results["fields"]) == {
        field["field"] for field in results.configuration["fields"]
    }
    assert "Ejecute el escáner" in es_results["emptyState"]
    summary = next(item for item in manifest.contributions if item.id == "summary")
    assert summary.localizations["es"]["fields"]["scannedSymbols"] == "Escaneados"
    signals = next(item for item in manifest.contributions if item.id == "signals")
    assert signals.localizations["es"]["title"] == "Señales del escáner de mercado"
    french = settings.localizations["fr"]["schema"]["properties"]["interval"]
    assert french["enumLabels"] == ["1 minute", "5 minutes", "1 heure"]
    assert results.localizations["fr"]["emptyState"] == (
        "Lancez le scanner pour afficher les résultats ici"
    )
    assert results.localizations["fr"]["fields"]["symbol"] == "Symbole"


def test_spanish_contract_errors_follow_parent_locale() -> None:
    error = PlatformContractError("invalid_request", "market scanner phase is invalid", "phase")
    translated = _localized_contract_error(error, "es-MX")
    assert translated.message == "la fase del escáner de mercado no es válida"
    assert (translated.code, translated.path) == (error.code, error.path)
    capability = PlatformContractError("unavailable", "market.bars.read capability is unavailable")
    assert _localized_contract_error(capability, "es-ES").message == (
        "Capacidad no disponible: market.bars.read"
    )
    assert _localized_contract_error(error, "pt-BR") is error
    assert "es" in _CONTRACT_LOCALIZATIONS


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


def test_plugin_owned_validation_error_follows_french_regional_locale() -> None:
    plugin = MarketScannerPlugin()
    request = InvokeRequest(
        contribution_id="scan",
        input={"unexpected": True},
        request_context=_context("fr-CA"),
    )
    with pytest.raises(PlatformContractError, match="n’accepte qu’une commande de scan"):
        plugin.invoke(request)
