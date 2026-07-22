from __future__ import annotations

from candlescope_plugin_sdk.platform_v2 import HOST_API_V1, PlatformJsonLineServer
from candlescope_plugin_sdk.platform_v2.examples.market_scanner import (
    MarketScannerPlugin,
    market_scanner_manifest,
)


def _request(request_id, method, *, generation, params):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
        "generation": generation,
    }


def test_market_scanner_chains_scoped_reads_storage_and_chart_marker() -> None:
    manifest = market_scanner_manifest()
    server = PlatformJsonLineServer(MarketScannerPlugin())
    server.handle_message(
        _request(
            "handshake",
            "handshake",
            generation=0,
            params={
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": [HOST_API_V1],
                "transports": ["jsonl/1"],
            },
        )
    )
    capabilities = [
        {
            "handle": f"cap-{item.id}",
            "permissionId": item.id,
            "scope": item.scope,
        }
        for item in manifest.permissions.required
    ]
    server.handle_message(
        _request(
            "activate",
            "activate",
            generation=1,
            params={
                "instanceId": "scanner-instance",
                "generation": 1,
                "capabilities": capabilities,
            },
        )
    )
    frames = server.handle_message(
        _request(
            "scan-invoke",
            "invoke",
            generation=1,
            params={
                "contributionId": "scan",
                "input": {},
                "requestContext": {
                    "contributionId": "scan",
                    "userAction": True,
                    "generation": 1,
                    "traceId": "scanner-test",
                },
            },
        )
    )
    methods: list[str] = []
    bar_index = 0
    while frames and frames[0].get("method") == "host.call":
        frame = frames[0]
        method = frame["params"]["method"]
        methods.append(method)
        if method == "settings.plugin.read":
            result = {
                "value": {
                    "quoteAsset": "USDT",
                    "symbolsLimit": 2,
                    "interval": "1h",
                    "lookbackBars": 2,
                    "minimumMovePct": 0,
                }
            }
        elif method == "market.symbols.read":
            result = {
                "symbols": [
                    {"symbol": "BTCUSDT"},
                    {"symbol": "ETHUSDT"},
                ]
            }
        elif method == "market.bars.read":
            bar_index += 1
            result = {
                "data": [
                    {
                        "time": 60,
                        "open": 100,
                        "high": 101,
                        "low": 99,
                        "close": 100,
                        "volume": 10,
                        "is_closed": True,
                    },
                    {
                        "time": 120,
                        "open": 100,
                        "high": 100 + bar_index,
                        "low": 99,
                        "close": 100 + bar_index,
                        "volume": 10,
                        "is_closed": True,
                    },
                ],
                "coverage": {"allRowsFinal": True},
            }
        elif method == "storage.document.put":
            assert frame["params"]["params"]["name"] == "latest-scan"
            result = {"stored": True, "revision": 1}
        elif method == "chart.layer.publish":
            render = frame["params"]["params"]["render"]
            assert render["items"][0]["type"] == "marker"
            result = {"published": True, "revision": 1}
        else:
            raise AssertionError(method)
        frames = server.handle_message(
            {
                "jsonrpc": "2.0",
                "id": frame["id"],
                "result": result,
                "generation": 1,
            }
        )

    assert methods == [
        "settings.plugin.read",
        "market.symbols.read",
        "market.bars.read",
        "market.bars.read",
        "storage.document.put",
        "chart.layer.publish",
    ]
    assert frames[0]["id"] == "scan-invoke"
    assert frames[0]["result"]["completed"] is True
    assert frames[0]["result"]["stored"] is True
    assert frames[0]["result"]["layerPublished"] is True
    assert len(frames[0]["result"]["matches"]) == 2
