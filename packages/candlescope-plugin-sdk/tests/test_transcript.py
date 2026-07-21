from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk import JsonLineRuntimeServer
from candlescope_plugin_sdk.examples.hello_runtime import HelloRuntime


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "hello_transcript_v1.json"


def _sha256(value: Any) -> str:
    canonical = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def test_hello_runtime_matches_protocol_v1_golden_transcript() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    server = JsonLineRuntimeServer(HelloRuntime())

    responses = [server.handle_message(request) for request in fixture["requests"]]

    assert [response.get("id") for response in responses] == [
        "handshake-1",
        "describe-1",
        "analyze-1",
        "execute-1",
        "shutdown-1",
    ]
    assert [response.get("error") for response in responses] == [None] * 5
    assert responses[0]["result"]["protocol"] == "candlescope.script-runtime/1"
    assert responses[3]["result"]["output"]["schema"] == "candlescope.render/1"
    assert responses[3]["result"]["output"]["series"][0]["data"][-1] == {
        "time": 1700000120,
        "value": 103.0,
    }
    assert [_sha256(response) for response in responses] == fixture["expected"]["responseSha256"]
    assert _sha256(responses) == fixture["expected"]["transcriptSha256"]
