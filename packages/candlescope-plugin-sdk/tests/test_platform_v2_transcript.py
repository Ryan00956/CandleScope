from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from candlescope_plugin_sdk.platform_v2 import (
    PlatformJsonLineServer,
    RpcRequest,
    RpcSuccess,
    canonical_dumps,
    canonical_sha256,
    parse_rpc_frame,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import (
    HelloCommandPlugin,
    hello_manifest,
)


ROOT = Path(__file__).parents[1]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "hello_command_transcript_v2.json"
V1_FIXTURE_PATH = ROOT / "tests" / "fixtures" / "hello_transcript_v1.json"
FROZEN_V1_FILE_SHA256 = "dd217159ab14af660481610cef5c369edbde3e7577bcf78e85bfad16cab5cf9c"
FROZEN_V1_TRANSCRIPT_SHA256 = (
    "sha256:021825fb264a63555e0eb331f24f6ea0632b0d2a0c962ef89a35673526391ba2"
)
FROZEN_V2_FIXTURE_FILE_SHA256 = "33fab9afb8ebed7ff81b70c20598a53733473fc79a2800fbcef1aa29ce006423"


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _replay_in_process(fixture: dict) -> list[dict]:
    server = PlatformJsonLineServer(HelloCommandPlugin())
    responses: list[dict] = []
    for request in fixture["requests"]:
        responses.extend(server.handle_message(request))
    return responses


def test_v2_hello_command_transcript_and_host_call_examples_are_frozen() -> None:
    fixture = _fixture()
    responses = _replay_in_process(fixture)
    expected = fixture["expected"]

    assert hashlib.sha256(FIXTURE_PATH.read_bytes()).hexdigest() == (FROZEN_V2_FIXTURE_FILE_SHA256)
    assert fixture["protocol"] == "candlescope.plugin/2"
    assert fixture["transport"] == "jsonl/1"
    assert [canonical_sha256(item) for item in responses] == expected["responseSha256"]
    assert canonical_sha256(responses) == expected["transcriptSha256"]
    assert (
        canonical_sha256(fixture["hostCallExample"]["pluginRequest"])
        == expected["hostCallRequestSha256"]
    )
    assert (
        canonical_sha256(fixture["hostCallExample"]["hostResponse"])
        == expected["hostCallResponseSha256"]
    )
    assert isinstance(parse_rpc_frame(fixture["hostCallExample"]["pluginRequest"]), RpcRequest)
    assert isinstance(parse_rpc_frame(fixture["hostCallExample"]["hostResponse"]), RpcSuccess)
    assert hello_manifest().probes[0].sha256 == expected["transcriptSha256"]


def test_v2_console_entrypoint_replays_the_same_canonical_transcript() -> None:
    fixture = _fixture()
    stdin_payload = "".join(canonical_dumps(request) + "\n" for request in fixture["requests"])
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        filter(None, (str(ROOT / "src"), environment.get("PYTHONPATH")))
    )
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "candlescope_plugin_sdk.platform_v2.examples.hello_command",
        ],
        cwd=ROOT,
        env=environment,
        input=stdin_payload,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        timeout=10,
    )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]

    assert completed.stderr == ""
    assert canonical_sha256(responses) == fixture["expected"]["transcriptSha256"]


def test_additive_v2_namespace_does_not_mutate_the_frozen_v1_fixture() -> None:
    fixture_bytes = V1_FIXTURE_PATH.read_bytes()
    fixture = json.loads(fixture_bytes)

    assert hashlib.sha256(fixture_bytes).hexdigest() == FROZEN_V1_FILE_SHA256
    assert fixture["expected"]["transcriptSha256"] == FROZEN_V1_TRANSCRIPT_SHA256
