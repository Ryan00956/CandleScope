from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "replay"


@pytest.mark.parametrize(
    ("filename", "source_kind"),
    [
        ("golden_bar_session_v1.json", "bar"),
        ("golden_agg_trade_session_v1.json", "agg_trade"),
    ],
)
def test_golden_session_freezes_config_command_log_and_final_hashes(
    filename: str,
    source_kind: str,
) -> None:
    payload = json.loads((FIXTURE_ROOT / filename).read_text(encoding="utf-8"))

    assert payload["schema_version"] == "replay-golden-session.v1"
    assert payload["source_kind"] == source_kind
    assert payload["config"]["source_kind"] == source_kind
    assert payload["command_log"]["common_prefix"]
    assert set(payload["command_log"]["paths"]) == {
        "step",
        "advance",
        "max",
        "speed_step",
        "pause_step",
        "checkpoint",
        "restart",
    }
    assert payload["final"]["state"] == "ENDED"
    assert payload["final"]["actor_state_hash"].startswith("sha256:")
    assert payload["final"]["report_hash"].startswith("sha256:")
    assert payload["ledger_audit"]["zero_difference"] is True
    assert payload["equivalence"]["all_equal"] is True


def test_cross_process_determinism_auditor_accepts_both_golden_sessions() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/audit_replay_determinism.py",
            "--repetitions",
            "2",
        ],
        cwd=BACKEND_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert completed.returncode == 0, completed.stderr
    report = json.loads(completed.stdout)
    assert report["passed"] is True
    assert report["sources"]["bar"]["passed"] is True
    assert report["sources"]["agg_trade"]["passed"] is True
