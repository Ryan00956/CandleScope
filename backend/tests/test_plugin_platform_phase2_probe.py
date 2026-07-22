from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).parents[1]
PROBE = BACKEND_ROOT / "scripts" / "plugin_platform_phase2_probe.py"


def test_phase2_probe_runs_the_real_in_memory_hello_slice() -> None:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in {"PYTHONPATH", "CANDLESCOPE_TEST_SECRET"}
    }
    completed = subprocess.run(
        [sys.executable, "-u", str(PROBE)],
        cwd=BACKEND_ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=15,
        text=True,
        encoding="utf-8",
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stderr == ""
    payload = json.loads(completed.stdout)
    assert payload == {
        "schemaVersion": 1,
        "protocol": "candlescope.plugin/2",
        "contributionId": "candlescope.hello-command.hello",
        "generation": 1,
        "invoke": {
            "message": "Hello, Plugin Platform v2!",
            "contributionId": "hello",
        },
        "eventBatch": {"accepted": 1},
        "health": {"status": "ready", "pending": 0},
        "activeSummary": {
            "status": "ok",
            "configured": 1,
            "enabled": 1,
            "active": 1,
            "failed": 0,
            "contributions": 1,
        },
        "stoppedState": "stopped",
    }
