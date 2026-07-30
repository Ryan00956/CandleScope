"""Fault-injectable JSON-RPC sidecar used by host supervision tests."""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any


MODE = sys.argv[1] if len(sys.argv) > 1 else "good"
RUNTIME_ID = "fake-runtime"
PACKAGE = "candlescope-plugin-fake"
VERSION = "1.2.3"
FEATURES = [
    "source-analysis/1",
    "batch-execution/1",
    "render.line-series/1",
]


def descriptor(*, changed: bool = False) -> dict[str, Any]:
    runtime_id = "other-runtime" if MODE == "identity-mismatch" else RUNTIME_ID
    version = "9.9.9" if changed else VERSION
    return {
        "id": runtime_id,
        "name": "Fake Runtime",
        "version": version,
        "package": PACKAGE,
        "languages": [
            {
                "id": "fake",
                "name": "Fake Script",
                "extensions": [".fake"],
                "aliases": [],
            }
        ],
        "features": FEATURES,
        "requiredHostFeatures": [
            "batch-execution/1",
            "render.line-series/1",
        ],
        "meta": {
            "secretPresent": "CANDLESCOPE_TEST_SECRET" in os.environ,
        },
    }


def respond(request_id: Any, result: Any) -> None:
    print(
        json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "result": result},
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ),
        flush=True,
    )


def main() -> int:
    if MODE == "stderr-flood":
        sys.stderr.write("S" * 200_000)
        sys.stderr.flush()

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request["id"]
        method = request["method"]

        if method == "handshake":
            if MODE == "crash-start":
                return 17
            respond(
                request_id,
                {
                    "protocol": "candlescope.script-runtime/1",
                    "runtime": descriptor(),
                    "negotiatedFeatures": FEATURES,
                },
            )
            continue

        if method == "describe":
            respond(request_id, descriptor(changed=MODE == "descriptor-changed"))
            continue

        if method == "analyze":
            if MODE == "timeout":
                time.sleep(30)
            if MODE == "crash":
                return 23
            if MODE == "bad-json":
                print("plugin wrote a log to stdout", flush=True)
                continue
            if MODE == "wrong-id":
                respond("not-the-request-id", {"ok": True})
                continue
            if MODE == "duplicate-key":
                print(
                    '{"jsonrpc":"2.0","id":"duplicate","id":"duplicate","result":{}}',
                    flush=True,
                )
                continue
            if MODE == "oversize":
                print("{" + '"padding":"' + ("x" * 10_000) + '"}', flush=True)
                continue
            if MODE == "remote-error":
                print(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "error": {
                                "code": -32602,
                                "message": "source is invalid",
                                "data": {"code": "INVALID_PARAMS", "field": "source"},
                            },
                        },
                        separators=(",", ":"),
                    ),
                    flush=True,
                )
                continue
            if MODE == "bad-result":
                respond(
                    request_id,
                    {
                        "ok": False,
                        "executable": True,
                        "diagnostics": [],
                        "inputs": [],
                        "dependencies": [],
                        "meta": {},
                    },
                )
                continue
            respond(
                request_id,
                {
                    "ok": True,
                    "executable": True,
                    "diagnostics": [],
                    "inputs": [],
                    "dependencies": [],
                    "meta": {},
                },
            )
            continue

        if method == "executeBatch":
            points = [
                {"time": bar["time"], "value": bar["close"]}
                for bar in request["params"]["bars"]
            ]
            respond(
                request_id,
                {
                    "ok": True,
                    "output": {
                        "schema": "candlescope.render/1",
                        "series": [
                            {
                                "id": "close",
                                "type": "line",
                                "title": "Close",
                                "pane": "main",
                                "scale": "right",
                                "style": {},
                                "data": points,
                            }
                        ],
                        "meta": {},
                    },
                    "diagnostics": [],
                    "meta": {},
                },
            )
            continue

        if method == "shutdown":
            respond(request_id, {"ok": True})
            if MODE == "ignore-shutdown":
                time.sleep(30)
            return 0

        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
