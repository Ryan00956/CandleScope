from __future__ import annotations

from importlib.resources import files

import jsonschema
import pytest

from candlescope_plugin_sdk.platform_v2 import (
    ActivationRequest,
    CapabilityGrant,
    HostCallInvocation,
    InvokeRequest,
    RequestContext,
    RpcSuccess,
    manifest_schema,
)
from candlescope_plugin_sdk.platform_v2.errors import PlatformContractError
from candlescope_plugin_pyne_workbench import PyneWorkbenchPlugin, pyne_workbench_manifest
from candlescope_plugin_pyne_workbench.plugin import _localized_contract_error


CHART = {
    "schemaVersion": "candlescope.chart-context/1",
    "chartId": "main-chart",
    "revision": 7,
    "active": True,
    "context": {"mode": "live", "exchange": "binance", "marketType": "spot"},
    "series": {"symbol": "BTCUSDT", "interval": "1m"},
    "updatedAtMs": 300_000,
}
BARS = {
    "data": [
        {"time": 60, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1, "is_closed": True},
        {
            "time": 120,
            "open": 10,
            "high": 12,
            "low": 9,
            "close": 11,
            "volume": 2,
            "is_closed": True,
        },
        {
            "time": 180,
            "open": 11,
            "high": 13,
            "low": 10,
            "close": 12,
            "volume": 3,
            "is_closed": True,
        },
    ],
    "coverage": {"allRowsFinal": True},
}


def _plugin() -> PyneWorkbenchPlugin:
    plugin = PyneWorkbenchPlugin()
    manifest = pyne_workbench_manifest()
    plugin.activate(
        ActivationRequest(
            "workbench-test",
            1,
            tuple(
                CapabilityGrant(f"cap-{item.id}", item.id, item.scope)
                for item in manifest.permissions.required
            ),
        )
    )
    return plugin


def _invoke(plugin: PyneWorkbenchPlugin, contribution: str, input_value: dict):
    return plugin.invoke(
        InvokeRequest(
            contribution,
            input_value,
            RequestContext(contribution, True, 1, f"trace-{contribution}"),
        )
    )


def _complete(plugin: PyneWorkbenchPlugin, call: HostCallInvocation, result: dict):
    return plugin.complete_host_call(call.token, RpcSuccess("host", result, 1))


def test_manifest_is_independent_v2_plugin_with_bounded_capabilities() -> None:
    manifest = pyne_workbench_manifest()
    jsonschema.validate(manifest.to_wire(), manifest_schema())
    assert manifest.plugin.id == "candlescope.pyne-workbench"
    assert {item.kind for item in manifest.contributions} >= {
        "command/1",
        "view/1",
        "chart-layer/2",
        "strategy-provider/1",
    }
    assert "pyne-workbench" in {item.id for item in manifest.backend_entrypoints}
    assert [item.id for item in manifest.permissions.required] == [
        "chart.context.read",
        "market.bars.read",
        "chart.layer.publish",
    ]


def test_sandbox_ui_owns_zh_cn_and_english_copy() -> None:
    web = files("candlescope_plugin_pyne_workbench").joinpath("web")
    html = web.joinpath("index.html").read_text(encoding="utf-8")
    javascript = web.joinpath("app.js").read_text(encoding="utf-8")

    assert 'data-i18n="statusWaiting"' in html
    assert '"zh-CN": {' in javascript
    assert "en: {" in javascript
    assert "es: {" in javascript
    assert "Banco de trabajo Pyne" in javascript
    assert "Esperando a CandleScope" in javascript
    assert "fr: {" in javascript
    assert "Atelier Pyne" in javascript
    assert "applyLocale(payload.locale)" in javascript
    assert 'setStatus("statusRejected")' in javascript


def test_packaged_manifest_owns_spanish_localizations() -> None:
    manifest = pyne_workbench_manifest()
    by_id = {item.id: item for item in manifest.contributions}
    assert by_id["run"].localizations["es"]["title"] == "Ejecutar Pyne en el gráfico actual"
    run_schema = by_id["run"].localizations["es"]["schema"]["properties"]
    assert run_schema["source"]["title"] == "Código fuente Pyne"
    assert run_schema["lookbackBars"]["title"] == "Barras de retrospectiva"
    assert (
        by_id["start-session"].localizations["es"]["title"] == "Iniciar sesión incremental de Pyne"
    )
    push_schema = by_id["push-bar"].localizations["es"]["schema"]["properties"]
    assert push_schema["open"]["title"] == "Apertura"
    assert push_schema["close"]["title"] == "Cierre"
    assert (
        by_id["snapshot-session"].localizations["es"]["title"]
        == "Crear instantánea de la sesión Pyne"
    )
    assert by_id["close-session"].localizations["es"]["title"] == "Cerrar sesión Pyne"
    assert (
        by_id["pyne-strategy"].localizations["es"]["title"]
        == "Proveedor de estrategia de prueba retrospectiva Pyne"
    )
    assert by_id["workbench-view"].localizations["es"]["title"] == "Banco de trabajo Pyne"
    assert by_id["pyne-output"].localizations["es"]["title"] == "Salida Pyne"


def test_manifest_owns_french_contribution_copy() -> None:
    manifest = pyne_workbench_manifest()
    titles = {
        item.id: item.localizations["fr"]["title"]
        for item in manifest.contributions
        if "fr" in item.localizations
    }
    assert titles["run"] == "Exécuter Pyne sur le graphique actuel"
    assert titles["workbench-view"] == "Atelier Pyne"
    assert titles["pyne-strategy"] == "Fournisseur de stratégie backtest Pyne"
    run = next(item for item in manifest.contributions if item.id == "run")
    assert run.localizations["fr"]["schema"]["properties"]["lookbackBars"]["title"] == (
        "Barres de rétrospection"
    )


def test_workbench_errors_follow_french_regional_locale() -> None:
    error = PlatformContractError("INVALID_CONTRACT", "Pyne session is not active")
    assert _localized_contract_error(error, "ja") is error
    translated = _localized_contract_error(error, "fr-CA")
    assert translated.message == "La session Pyne n’est pas active"
    capability = PlatformContractError(
        "INVALID_CONTRACT", "chart.layer.publish capability is unavailable"
    )
    assert _localized_contract_error(capability, "fr").message == (
        "Capacité chart.layer.publish indisponible"
    )
    plugin = _plugin()
    with pytest.raises(PlatformContractError, match="n’est pas invocable"):
        plugin.invoke(
            InvokeRequest(
                "not-a-contribution",
                {},
                RequestContext("not-a-contribution", True, 1, "trace-fr", locale="fr-CA"),
            )
        )


def test_batch_command_reads_chart_bars_and_publishes_render_v2() -> None:
    plugin = _plugin()
    first = _invoke(
        plugin,
        "run",
        {"source": 'indicator("Test")\nplot(close, "Close")', "lookbackBars": 3},
    )
    assert isinstance(first, HostCallInvocation) and first.call.method == "chart.context.read"
    second = _complete(plugin, first, CHART)
    assert isinstance(second, HostCallInvocation) and second.call.method == "market.bars.read"
    third = _complete(plugin, second, BARS)
    assert isinstance(third, HostCallInvocation) and third.call.method == "chart.layer.publish"
    assert third.call.params["render"]["schemaVersion"] == "candlescope.render/2"
    assert third.call.params["render"]["items"][0]["type"] == "polyline"
    done = _complete(plugin, third, {"published": True, "revision": 1})
    assert done["completed"] is True
    assert done["layerPublished"] is True
    assert done["pyneOutputSchema"] == 2


def test_batch_command_brokers_exact_request_data_before_publish() -> None:
    plugin = _plugin()
    first = _invoke(
        plugin,
        "run",
        {
            "source": (
                'requested = request.security("BTCUSDT", "5m", close)\nplot(requested, "Requested")'
            ),
            "lookbackBars": 3,
        },
    )
    second = _complete(plugin, first, CHART)
    broker = _complete(plugin, second, BARS)
    assert isinstance(broker, HostCallInvocation)
    assert broker.call.method == "market.bars.read"
    assert broker.call.params["series"] == {"symbol": "BTCUSDT", "interval": "5m"}
    publish = _complete(plugin, broker, BARS)
    assert isinstance(publish, HostCallInvocation)
    assert publish.call.method == "chart.layer.publish"
    done = _complete(plugin, publish, {"published": True, "revision": 2})
    assert done["completed"] is True


INCREMENTAL_SOURCE = """
indicator("Session", mode="incremental", overlay=True)
def on_bar(ctx, bar):
    ctx.plot("Close", bar.close)
"""


def test_incremental_session_start_push_snapshot_and_close() -> None:
    plugin = _plugin()
    first = _invoke(
        plugin,
        "start-session",
        {
            "sessionId": "dev-one",
            "source": INCREMENTAL_SOURCE,
            "lookbackBars": 3,
            "retentionBars": 10,
        },
    )
    second = _complete(plugin, first, CHART)
    publish = _complete(plugin, second, BARS)
    assert isinstance(publish, HostCallInvocation)
    started = _complete(plugin, publish, {"published": True, "revision": 3})
    assert started["completed"] is True
    assert started["sessionId"] == "dev-one"

    pushed = _invoke(
        plugin,
        "push-bar",
        {
            "sessionId": "dev-one",
            "time": 240,
            "open": 12,
            "high": 14,
            "low": 11,
            "close": 13,
            "volume": 4,
            "preview": False,
        },
    )
    assert isinstance(pushed, HostCallInvocation)
    pushed_done = _complete(plugin, pushed, {"published": True, "revision": 4})
    assert pushed_done["operation"] == "push-bar"

    snapshot = _invoke(plugin, "snapshot-session", {"sessionId": "dev-one"})
    assert isinstance(snapshot, HostCallInvocation)
    snapshot_done = _complete(plugin, snapshot, {"published": True, "revision": 5})
    assert snapshot_done["operation"] == "snapshot-session"

    closed = _invoke(plugin, "close-session", {"sessionId": "dev-one"})
    assert closed["closed"] is True
