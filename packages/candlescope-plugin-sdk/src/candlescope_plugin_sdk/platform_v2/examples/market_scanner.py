"""Read-only Market Scanner reference plugin for the Phase 6 Host."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from importlib.resources import files
from typing import Any

from ..errors import PlatformContractError
from ..json_codec import loads_strict
from ..models import (
    ActivationRequest,
    HostCallRequest,
    InvokeRequest,
    PluginManifest,
    RequestContext,
    RuntimeDescriptor,
    descriptor_from_manifest,
)
from ..render import RENDER_IR_V1
from ..rpc import RpcFailure, RpcSuccess
from ..runtime import BasePlatformPlugin, HostCallInvocation, InvocationOutcome
from ..server import serve_platform_plugin


def market_scanner_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("market-scanner.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


@dataclass(slots=True)
class _ScanState:
    context: RequestContext
    phase: str = "settings"
    settings: dict[str, Any] = field(default_factory=dict)
    symbols: list[str] = field(default_factory=list)
    index: int = 0
    results: list[dict[str, Any]] = field(default_factory=list)
    scan_result: dict[str, Any] = field(default_factory=dict)


class MarketScannerPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = market_scanner_manifest()
        self._capabilities: dict[str, str] = {}
        self._pending: dict[str, _ScanState] = {}
        self._layer_revision = 0

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        self._capabilities = {item.permission_id: item.handle for item in request.capabilities}
        self._pending.clear()
        self._layer_revision = 0

    def deactivate(self, reason: str) -> None:
        self._capabilities.clear()
        self._pending.clear()

    def cancel(self, token: str) -> None:
        self._pending.pop(token, None)

    def health_check(self) -> dict[str, Any]:
        return {"status": "ready", "pendingScans": len(self._pending)}

    def _host_call(
        self,
        token: str,
        state: _ScanState,
        *,
        permission_id: str,
        method: str,
        params: dict[str, Any],
        phase: str,
    ) -> HostCallInvocation:
        handle = self._capabilities.get(permission_id)
        if handle is None:
            raise PlatformContractError(
                "INVALID_CONTRACT", f"{permission_id} capability is unavailable"
            )
        state.phase = phase
        return HostCallInvocation(
            token=token,
            call=HostCallRequest(
                capability_handle=handle,
                method=method,
                params=params,
                request_context=state.context,
            ),
        )

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        if request.contribution_id != "scan" or request.input != {}:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "market scanner accepts only an empty scan command",
                "invoke.input",
            )
        token = "scan-" + uuid.uuid4().hex
        state = _ScanState(request.request_context)
        self._pending[token] = state
        return self._host_call(
            token,
            state,
            permission_id="settings.plugin.read",
            method="settings.plugin.read",
            params={"settingsId": "settings"},
            phase="settings",
        )

    @staticmethod
    def _market_context() -> dict[str, str]:
        return {"mode": "live", "exchange": "binance", "marketType": "spot"}

    def _read_symbol(self, token: str, state: _ScanState) -> HostCallInvocation:
        symbol = state.symbols[state.index]
        return self._host_call(
            token,
            state,
            permission_id="market.bars.read",
            method="market.bars.read",
            params={
                "context": self._market_context(),
                "series": {
                    "symbol": symbol,
                    "interval": state.settings["interval"],
                },
                "limit": state.settings["lookbackBars"],
            },
            phase="bars",
        )

    def _store_result(self, token: str, state: _ScanState) -> HostCallInvocation:
        state.results.sort(key=lambda item: abs(item["changePct"]), reverse=True)
        selected = [
            item
            for item in state.results
            if abs(item["changePct"]) >= state.settings["minimumMovePct"]
        ]
        state.scan_result = {
            "schemaVersion": "candlescope.market-scanner-result/1",
            "context": self._market_context(),
            "interval": state.settings["interval"],
            "scannedSymbols": len(state.symbols),
            "matches": selected,
        }
        return self._host_call(
            token,
            state,
            permission_id="storage.private",
            method="storage.document.put",
            params={"name": "latest-scan", "value": state.scan_result},
            phase="storage",
        )

    def _publish_marker(self, token: str, state: _ScanState) -> HostCallInvocation | dict[str, Any]:
        matches = state.scan_result["matches"]
        if not matches:
            self._pending.pop(token, None)
            return {
                "completed": True,
                "stored": True,
                "scannedSymbols": state.scan_result["scannedSymbols"],
                "matches": [],
                "layerPublished": False,
            }
        top = matches[0]
        self._layer_revision += 1
        return self._host_call(
            token,
            state,
            permission_id="chart.layer.publish",
            method="chart.layer.publish",
            params={
                "layerId": "signals",
                "context": self._market_context(),
                "series": {
                    "symbol": top["symbol"],
                    "interval": state.settings["interval"],
                },
                "revision": self._layer_revision,
                "render": {
                    "schemaVersion": RENDER_IR_V1,
                    "items": [
                        {
                            "id": f"scan-{self._layer_revision}",
                            "type": "marker",
                            "time": top["time"],
                            "position": "aboveBar" if top["changePct"] >= 0 else "belowBar",
                            "shape": "arrowUp" if top["changePct"] >= 0 else "arrowDown",
                            "color": "#22C55E" if top["changePct"] >= 0 else "#EF4444",
                            "text": f"{top['symbol']} {top['changePct']:+.2f}%",
                            "price": top["close"],
                        }
                    ],
                },
            },
            phase="chart",
        )

    def complete_host_call(
        self,
        token: str,
        response: RpcSuccess | RpcFailure,
    ) -> InvocationOutcome:
        state = self._pending.get(token)
        if state is None:
            raise PlatformContractError(
                "INVALID_CONTRACT", "market scanner completion token is stale"
            )
        if isinstance(response, RpcFailure):
            self._pending.pop(token, None)
            return {
                "completed": False,
                "phase": state.phase,
                "error": response.error.code,
            }
        result = response.result
        if state.phase == "settings":
            settings = result.get("value")
            if not isinstance(settings, dict):
                raise PlatformContractError(
                    "INVALID_CONTRACT", "Host returned invalid scanner settings"
                )
            state.settings = dict(settings)
            return self._host_call(
                token,
                state,
                permission_id="market.symbols.read",
                method="market.symbols.read",
                params={
                    "context": self._market_context(),
                    "quoteAsset": state.settings["quoteAsset"],
                    "limit": state.settings["symbolsLimit"],
                },
                phase="symbols",
            )
        if state.phase == "symbols":
            raw_symbols = result.get("symbols")
            if not isinstance(raw_symbols, list):
                raise PlatformContractError(
                    "INVALID_CONTRACT", "Host returned an invalid symbol page"
                )
            state.symbols = [
                str(item["symbol"])
                for item in raw_symbols
                if isinstance(item, dict) and isinstance(item.get("symbol"), str)
            ][: state.settings["symbolsLimit"]]
            if not state.symbols:
                return self._store_result(token, state)
            state.index = 0
            return self._read_symbol(token, state)
        if state.phase == "bars":
            rows = result.get("data")
            if isinstance(rows, list) and len(rows) >= 2:
                first = rows[0]
                last = rows[-1]
                first_close = float(first["close"])
                if first_close != 0:
                    state.results.append(
                        {
                            "symbol": state.symbols[state.index],
                            "changePct": (float(last["close"]) / first_close - 1) * 100,
                            "time": int(last["time"]),
                            "close": float(last["close"]),
                            "allRowsFinal": result.get("coverage", {}).get("allRowsFinal") is True,
                        }
                    )
            state.index += 1
            if state.index < len(state.symbols):
                return self._read_symbol(token, state)
            return self._store_result(token, state)
        if state.phase == "storage":
            return self._publish_marker(token, state)
        if state.phase == "chart":
            self._pending.pop(token, None)
            return {
                "completed": True,
                "stored": True,
                "scannedSymbols": state.scan_result["scannedSymbols"],
                "matches": state.scan_result["matches"],
                "layerPublished": True,
                "layerReceipt": result,
            }
        raise PlatformContractError("INVALID_CONTRACT", "market scanner phase is invalid")


def main() -> int:
    return serve_platform_plugin(MarketScannerPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
