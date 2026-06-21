from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_request_capture_status_json_report() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_status.py"),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)

    assert report["counts"] == {
        "total": 21,
        "captured": 21,
        "not_captured": 0,
        "missing": 0,
        "priority_total": 8,
        "priority_captured": 8,
    }
    first = report["fixtures"][0]
    assert first["fixture"] == "request_security_htf_capture.json"
    assert first["priority"] is True
    assert first["status"] == "captured"
    assert first["assertion"] == "parity"
    second = report["fixtures"][1]
    assert second["fixture"] == "request_security_lower_tf_capture.json"
    assert second["priority"] is True
    assert second["status"] == "captured"
    assert second["assertion"] == "parity"
    assert second["plot_count"] == 20
    third = report["fixtures"][2]
    assert third["fixture"] == "request_security_time_close_capture.json"
    assert third["priority"] is True
    assert third["status"] == "captured"
    assert third["assertion"] == "parity"
    assert third["plot_count"] == 9
    fourth = report["fixtures"][3]
    assert fourth["fixture"] == "request_security_metadata_capture.json"
    assert fourth["priority"] is True
    assert fourth["status"] == "captured"
    assert fourth["assertion"] == "parity"
    assert fourth["plot_count"] == 11
    fifth = report["fixtures"][4]
    assert fifth["fixture"] == "request_security_gaps_lookahead_capture.json"
    assert fifth["priority"] is True
    assert fifth["status"] == "captured"
    assert fifth["assertion"] == "parity"
    assert fifth["plot_count"] == 10
    sixth = report["fixtures"][5]
    assert sixth["fixture"] == "request_security_daily_context_capture.json"
    assert sixth["priority"] is True
    assert sixth["status"] == "captured"
    assert sixth["assertion"] == "parity"
    assert sixth["plot_count"] == 13
    seventh = report["fixtures"][6]
    assert seventh["fixture"] == "request_security_session_flags_capture.json"
    assert seventh["priority"] is True
    assert seventh["status"] == "captured"
    assert seventh["assertion"] == "parity"
    assert seventh["plot_count"] == 9
    eighth = report["fixtures"][7]
    assert eighth["fixture"] == "request_security_timezone_capture.json"
    assert eighth["priority"] is True
    assert eighth["status"] == "captured"
    assert eighth["assertion"] == "parity"
    assert eighth["plot_count"] == 10
    ninth = report["fixtures"][8]
    assert ninth["fixture"] == "request_security_expression_context_capture.json"
    assert ninth["priority"] is False
    assert ninth["status"] == "captured"
    assert ninth["assertion"] == "parity"
    assert ninth["plot_count"] == 9
    tenth = report["fixtures"][9]
    assert tenth["fixture"] == "request_security_invalid_symbol_expression_ignore_capture.json"
    assert tenth["priority"] is False
    assert tenth["status"] == "captured"
    assert tenth["assertion"] == "parity"
    assert tenth["plot_count"] == 9
    eleventh = report["fixtures"][10]
    assert eleventh["fixture"] == "request_security_invalid_symbol_ignore_capture.json"
    assert eleventh["priority"] is False
    assert eleventh["status"] == "captured"
    assert eleventh["assertion"] == "parity"
    assert eleventh["plot_count"] == 9
    twelfth = report["fixtures"][11]
    assert twelfth["fixture"] == "request_security_invalid_symbol_tuple_ignore_capture.json"
    assert twelfth["priority"] is False
    assert twelfth["status"] == "captured"
    assert twelfth["assertion"] == "parity"
    assert twelfth["plot_count"] == 12
    thirteenth = report["fixtures"][12]
    assert thirteenth["fixture"] == "request_security_lower_tf_helpers_capture.json"
    assert thirteenth["priority"] is False
    assert thirteenth["status"] == "captured"
    assert thirteenth["assertion"] == "parity"
    assert thirteenth["plot_count"] == 20
    fourteenth = report["fixtures"][13]
    assert fourteenth["fixture"] == (
        "request_security_lower_tf_invalid_symbol_expression_ignore_capture.json"
    )
    assert fourteenth["priority"] is False
    assert fourteenth["status"] == "captured"
    assert fourteenth["assertion"] == "parity"
    assert fourteenth["plot_count"] == 6
    fifteenth = report["fixtures"][14]
    assert fifteenth["fixture"] == "request_security_lower_tf_invalid_symbol_ignore_capture.json"
    assert fifteenth["priority"] is False
    assert fifteenth["status"] == "captured"
    assert fifteenth["assertion"] == "parity"
    assert fifteenth["plot_count"] == 6
    sixteenth = report["fixtures"][15]
    assert sixteenth["fixture"] == (
        "request_security_lower_tf_invalid_symbol_tuple_ignore_capture.json"
    )
    assert sixteenth["priority"] is False
    assert sixteenth["status"] == "captured"
    assert sixteenth["assertion"] == "parity"
    assert sixteenth["plot_count"] == 10
    seventeenth = report["fixtures"][16]
    assert seventeenth["fixture"] == "request_security_lower_tf_invalid_timeframe_ignore_capture.json"
    assert seventeenth["priority"] is False
    assert seventeenth["status"] == "captured"
    assert seventeenth["assertion"] == "parity"
    assert seventeenth["plot_count"] == 6
    eighteenth = report["fixtures"][17]
    assert eighteenth["fixture"] == (
        "request_security_lower_tf_invalid_timeframe_tuple_ignore_capture.json"
    )
    assert eighteenth["priority"] is False
    assert eighteenth["status"] == "captured"
    assert eighteenth["assertion"] == "parity"
    assert eighteenth["plot_count"] == 10
    nineteenth = report["fixtures"][18]
    assert nineteenth["fixture"] == "request_security_lower_tf_requested_context_capture.json"
    assert nineteenth["priority"] is False
    assert nineteenth["status"] == "captured"
    assert nineteenth["assertion"] == "parity"
    assert nineteenth["plot_count"] == 19
    twentieth = report["fixtures"][19]
    assert twentieth["fixture"] == "request_security_lower_tf_timezone_capture.json"
    assert twentieth["priority"] is False
    assert twentieth["status"] == "captured"
    assert twentieth["assertion"] == "parity"
    assert twentieth["plot_count"] == 17
    twentyfirst = report["fixtures"][20]
    assert twentyfirst["fixture"] == "request_security_same_timeframe_capture.json"
    assert twentyfirst["priority"] is False
    assert twentyfirst["status"] == "captured"
    assert twentyfirst["assertion"] == "parity"
    assert twentyfirst["plot_count"] == 12
