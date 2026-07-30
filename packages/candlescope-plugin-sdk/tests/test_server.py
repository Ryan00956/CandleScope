from __future__ import annotations

import io
import json

from candlescope_plugin_sdk import AnalyzeResult, JsonLineRuntimeServer, PROTOCOL_V1
from candlescope_plugin_sdk.examples.hello_runtime import HelloRuntime


def _request(request_id: int, method: str, params: dict | None = None) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
    }


def _handshake(*features: str) -> dict:
    return _request(
        1,
        "handshake",
        {
            "protocols": [PROTOCOL_V1],
            "host": {"name": "CandleScope", "version": "0.1.0"},
            "hostFeatures": list(features),
        },
    )


def test_server_requires_handshake_before_runtime_methods() -> None:
    response = JsonLineRuntimeServer(HelloRuntime()).handle_message(_request(1, "describe"))

    assert response["error"]["code"] == -32001
    assert response["error"]["data"]["code"] == "HANDSHAKE_REQUIRED"


def test_handshake_rejects_missing_required_host_feature() -> None:
    response = JsonLineRuntimeServer(HelloRuntime()).handle_message(_handshake("batch-execution/1"))

    assert response["error"]["code"] == -32003
    assert response["error"]["data"]["missingFeatures"] == ["render.line-series/1"]


def test_handshake_rejects_unsupported_protocol_and_repeated_negotiation() -> None:
    unsupported_server = JsonLineRuntimeServer(HelloRuntime())
    unsupported = unsupported_server.handle_message(
        _request(
            1,
            "handshake",
            {
                "protocols": ["candlescope.script-runtime/999"],
                "host": {"name": "CandleScope", "version": "0.1.0"},
                "hostFeatures": [],
            },
        )
    )

    server = JsonLineRuntimeServer(HelloRuntime())
    request = _handshake(
        "source-analysis/1",
        "batch-execution/1",
        "render.line-series/1",
    )
    first = server.handle_message(request)
    repeated = server.handle_message(request)

    assert unsupported["error"]["data"]["code"] == "PROTOCOL_UNSUPPORTED"
    assert first["result"]["protocol"] == PROTOCOL_V1
    assert repeated["error"]["data"]["code"] == "HANDSHAKE_ALREADY_COMPLETED"


def test_optional_analysis_must_be_negotiated_before_use() -> None:
    server = JsonLineRuntimeServer(HelloRuntime())
    handshake = server.handle_message(_handshake("batch-execution/1", "render.line-series/1"))
    analysis = server.handle_message(
        _request(
            2,
            "analyze",
            {
                "source": "plot(close)",
                "context": {
                    "exchange": "binance",
                    "marketType": "spot",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                },
            },
        )
    )

    assert handshake["result"]["negotiatedFeatures"] == [
        "batch-execution/1",
        "render.line-series/1",
    ]
    assert analysis["error"]["data"]["code"] == "FEATURE_NOT_NEGOTIATED"


def test_server_maps_invalid_json_and_unknown_methods_to_json_rpc_errors() -> None:
    server = JsonLineRuntimeServer(HelloRuntime())

    parse_error = server.handle_line("not-json")
    server.handle_message(
        _handshake(
            "source-analysis/1",
            "batch-execution/1",
            "render.line-series/1",
        )
    )
    method_error = server.handle_message(_request(2, "unknown"))

    assert parse_error["id"] is None
    assert parse_error["error"]["code"] == -32700
    assert method_error["error"]["code"] == -32601


def test_server_rejects_duplicate_keys_and_non_standard_numbers() -> None:
    server = JsonLineRuntimeServer(HelloRuntime())

    duplicate = server.handle_line('{"jsonrpc":"2.0","id":1,"id":2,"method":"handshake"}')
    nan_value = server.handle_line(
        '{"jsonrpc":"2.0","id":1,"method":"handshake","params":{"x":NaN}}'
    )

    assert duplicate["error"]["data"]["code"] == "PARSE_ERROR"
    assert nan_value["error"]["data"]["code"] == "PARSE_ERROR"


def test_server_flushes_shutdown_response_and_stops_reading() -> None:
    requests = [
        _handshake(
            "source-analysis/1",
            "batch-execution/1",
            "render.line-series/1",
        ),
        _request(2, "shutdown"),
        _request(3, "describe"),
    ]
    stdin = io.StringIO("".join(json.dumps(item) + "\n" for item in requests))
    stdout = io.StringIO()

    exit_code = JsonLineRuntimeServer(HelloRuntime()).serve(stdin, stdout)
    responses = [json.loads(line) for line in stdout.getvalue().splitlines()]

    assert exit_code == 0
    assert [item["id"] for item in responses] == [1, 2]
    assert responses[-1]["result"] == {"ok": True}


def test_message_limit_fails_closed_before_json_parsing() -> None:
    response = JsonLineRuntimeServer(
        HelloRuntime(),
        max_message_bytes=8,
    ).handle_line('{"jsonrpc":"2.0"}')

    assert response["error"]["data"] == {
        "code": "MESSAGE_TOO_LARGE",
        "maxMessageBytes": 8,
    }


def test_non_json_plugin_result_becomes_protocol_error() -> None:
    class BrokenRuntime(HelloRuntime):
        def analyze(self, request):
            return AnalyzeResult(ok=True, executable=True, meta={"bad": object()})

    requests = [
        _handshake(
            "source-analysis/1",
            "batch-execution/1",
            "render.line-series/1",
        ),
        _request(
            2,
            "analyze",
            {
                "source": "plot(close)",
                "context": {
                    "exchange": "binance",
                    "marketType": "spot",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                },
            },
        ),
    ]
    stdin = io.StringIO("".join(json.dumps(item) + "\n" for item in requests))
    stdout = io.StringIO()

    JsonLineRuntimeServer(BrokenRuntime()).serve(stdin, stdout)
    responses = [json.loads(line) for line in stdout.getvalue().splitlines()]

    assert responses[1]["error"]["data"]["code"] == "PLUGIN_RESULT_NOT_JSON"


def test_unexpected_plugin_exception_is_hidden_from_json_rpc_client(capsys) -> None:
    class ExplodingRuntime(HelloRuntime):
        def analyze(self, request):
            raise RuntimeError("private implementation detail")

    server = JsonLineRuntimeServer(ExplodingRuntime())
    server.handle_message(
        _handshake(
            "source-analysis/1",
            "batch-execution/1",
            "render.line-series/1",
        )
    )
    response = server.handle_message(
        _request(
            2,
            "analyze",
            {
                "source": "plot(close)",
                "context": {
                    "exchange": "binance",
                    "marketType": "spot",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                },
            },
        )
    )

    captured = capsys.readouterr()
    assert response["error"]["data"]["code"] == "INTERNAL_ERROR"
    assert "private implementation detail" not in json.dumps(response)
    assert "private implementation detail" in captured.err
