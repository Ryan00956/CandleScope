from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_request_capture_prepare_priority_manifest(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert "prepared 8 request capture script(s)" in completed.stdout
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["capture_type"] == "request"
    assert manifest["default_scope"] == "priority"
    assert manifest["fixture_count"] == 8
    first = manifest["entries"][0]
    assert first["fixture"] == "request_security_htf_capture.json"
    assert first["priority"] is True
    assert first["status"] == "captured"
    assert first["bar_count"] == 12
    assert first["capture_index_title"] == "Pyne Capture Index"
    assert first["plot_titles"] == [
        "HTF Close",
        "HTF Close Gapped",
        "HTF Close Lookahead",
        "HTF Previous Close",
        "HTF Requested Open",
        "HTF Requested High",
        "HTF Requested Low",
        "HTF Time",
        "HTF Open",
        "HTF High",
        "HTF Low",
        "HTF Provider Close",
        "HTF Volume",
    ]

    pine_text = (out_dir / first["pine_file"]).read_text(encoding="utf-8")
    assert pine_text.startswith("//@version=5\n_pyne_capture_bars = 12\n")
    assert 'indicator("Pyne Request Capture - HTF Alignment", overlay=true)' in pine_text
    assert 'request.security(syminfo.tickerid, "240", close' in pine_text
    assert '"HTF Time"' in pine_text
    assert (out_dir / first["bars_file"]).read_text(encoding="utf-8").startswith(
        "time,open,high,low,close,volume\n"
    )

    second = manifest["entries"][1]
    assert second["fixture"] == "request_security_lower_tf_capture.json"
    assert second["priority"] is True
    assert second["status"] == "captured"
    assert second["bar_count"] == 4
    assert "--assertion parity" in second["import_command"]
    assert "--assertion parity" in second["diff_command"]
    assert second["plot_titles"][:8] == [
        "LTF Count",
        "LTF First Close",
        "LTF Second Close",
        "LTF Last Close",
        "LTF Sum Close",
        "LTF Avg Close",
        "LTF Tuple Mid First",
        "LTF Tuple Range Sum",
    ]
    pine_text = (out_dir / second["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - LTF Grouping", overlay=true)' in pine_text
    assert "_pyne_ltf_get(array<float> arr, int idx, float fallback)" in pine_text
    assert "_pyne_ltf_last(array<float> arr, float fallback)" in pine_text
    assert "request.security_lower_tf" in pine_text

    third = manifest["entries"][2]
    assert third["fixture"] == "request_security_time_close_capture.json"
    assert third["priority"] is True
    assert third["status"] == "captured"
    assert third["bar_count"] == 12
    assert "--assertion parity" in third["import_command"]
    assert third["plot_titles"][:4] == [
        "HTF Time",
        "HTF Time Close",
        "HTF Duration",
        "HTF Close",
    ]
    pine_text = (out_dir / third["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - Time Close", overlay=true)' in pine_text
    assert "time_close" in pine_text

    fourth = manifest["entries"][3]
    assert fourth["fixture"] == "request_security_metadata_capture.json"
    assert fourth["priority"] is True
    assert fourth["status"] == "captured"
    assert fourth["bar_count"] == 12
    assert "--assertion parity" in fourth["import_command"]
    assert fourth["plot_titles"][:5] == [
        "Requested Mintick",
        "Requested TF Multiplier",
        "Requested TF Intraday",
        "Requested TF Daily",
        "Requested Session Market",
    ]
    pine_text = (out_dir / fourth["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - Metadata", overlay=true)' in pine_text
    assert "syminfo.mintick" in pine_text
    assert "timeframe.multiplier" in pine_text
    assert "session.ismarket" in pine_text

    fifth = manifest["entries"][4]
    assert fifth["fixture"] == "request_security_gaps_lookahead_capture.json"
    assert fifth["priority"] is True
    assert fifth["status"] == "captured"
    assert fifth["bar_count"] == 12
    assert "--assertion parity" in fifth["import_command"]
    assert fifth["plot_titles"][:4] == [
        "Close Gaps Off Lookahead Off",
        "Close Gaps On Lookahead Off",
        "Close Gaps Off Lookahead On",
        "Close Gaps On Lookahead On",
    ]
    pine_text = (out_dir / fifth["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - Gaps Lookahead", overlay=true)' in pine_text
    assert "gaps=barmerge.gaps_off" in pine_text
    assert "gaps=barmerge.gaps_on" in pine_text
    assert "lookahead=barmerge.lookahead_off" in pine_text
    assert "lookahead=barmerge.lookahead_on" in pine_text

    sixth = manifest["entries"][5]
    assert sixth["fixture"] == "request_security_daily_context_capture.json"
    assert sixth["priority"] is True
    assert sixth["status"] == "captured"
    assert sixth["bar_count"] == 48
    assert "--assertion parity" in sixth["import_command"]
    assert sixth["plot_titles"][:7] == [
        "Daily Time",
        "Daily Time Close",
        "Daily Duration",
        "Daily Close",
        "Daily TF Multiplier",
        "Daily TF Intraday",
        "Daily TF Daily",
    ]
    pine_text = (out_dir / sixth["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - Daily Context", overlay=true)' in pine_text
    assert 'request.security(syminfo.tickerid, "1D"' in pine_text
    assert "time_close" in pine_text
    assert "timeframe.isdaily" in pine_text

    seventh = manifest["entries"][6]
    assert seventh["fixture"] == "request_security_session_flags_capture.json"
    assert seventh["priority"] is True
    assert seventh["status"] == "captured"
    assert seventh["bar_count"] == 12
    assert "--assertion parity" in seventh["import_command"]
    assert seventh["plot_titles"][:3] == [
        "Requested Session Market",
        "Requested Session First",
        "Requested Session Last",
    ]
    pine_text = (out_dir / seventh["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - Session Flags", overlay=true)' in pine_text
    assert "session.ismarket" in pine_text
    assert "session.isfirstbar" in pine_text
    assert "session.islastbar" in pine_text

    eighth = manifest["entries"][7]
    assert eighth["fixture"] == "request_security_timezone_capture.json"
    assert eighth["priority"] is True
    assert eighth["status"] == "captured"
    assert eighth["bar_count"] == 12
    assert "--assertion parity" in eighth["import_command"]
    assert eighth["plot_titles"][:4] == [
        "Requested UTC Hour",
        "Requested Shanghai Hour",
        "Requested UTC Day",
        "Requested Shanghai Day",
    ]
    pine_text = (out_dir / eighth["pine_file"]).read_text(encoding="utf-8")
    assert 'indicator("Pyne Request Capture - Timezone", overlay=true)' in pine_text
    assert 'hour(time, "UTC")' in pine_text
    assert 'hour(time, "Asia/Shanghai")' in pine_text
    assert 'dayofweek(time, "Asia/Shanghai")' in pine_text
