from __future__ import annotations

import json
import os
import subprocess
import time

import pytest

from app.alerts.indicator_context import _optional_float, indicator_readiness
from app.alerts.store import AlertStore
from app.alerts.webhook import WebhookSettings
from app.api.v1.settings import _get_system_proxy
from app.api.v1.stream_utils import normalize_exchange
from app.core import config
from app.plugin_security_v2.windows_runner import _directory_size


def test_dotenv_values_remain_available_to_runtime_without_child_inheritance(
    monkeypatch,
):
    defaults = {
        "ALERT_WEBHOOK_ENABLED": "1",
        "ALERT_WEBHOOK_SECRET": "test-signing-key",
        "ALERT_WEBHOOK_ALLOWED_HOSTS": "hooks.example.com",
        "HTTPS_PROXY": "http://127.0.0.1:12345",
    }
    for name, value in defaults.items():
        monkeypatch.delenv(name, raising=False)
        monkeypatch.setitem(config._DOTENV_ADDED_VALUES, name, value)
    settings = WebhookSettings.from_env()
    assert settings.ready and settings.secret == "test-signing-key"
    assert _get_system_proxy() == "http://127.0.0.1:12345"
    assert all(name not in os.environ for name in defaults)
    monkeypatch.setenv("ALERT_WEBHOOK_ENABLED", "0")
    assert WebhookSettings.from_env().enabled is False


def test_alert_observations_and_legacy_nonfinite_json_remain_standard(tmp_path):
    assert _optional_float(float("inf")) is None
    assert indicator_readiness(
        {"rsi": float("-inf"), "macdHist": float("nan"), "ma20": 2}
    ) == {
        "rsi": False,
        "macdHist": False,
        "ma20": True,
    }
    path = tmp_path / "alerts.json"
    store = AlertStore(path)
    record = store.append_history(
        {"ruleId": "test", "values": {"x": float("inf"), "nested": [float("nan"), 3]}}
    )
    assert record["values"] == {"x": None, "nested": [None, 3]}

    def reject_constant(value):
        raise AssertionError(value)

    json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    path.write_text(
        '{"schemaVersion":1,"rules":{},"history":[{"id":"legacy","values":{"x":Infinity}}]}',
        encoding="utf-8",
    )
    assert store.list_history()[0]["values"]["x"] is None


def test_unknown_exchange_never_falls_back_to_another_venue():
    with pytest.raises(ValueError, match="Unsupported exchange"):
        normalize_exchange("okxx")
    assert normalize_exchange(" OKX ") == "okx"


@pytest.mark.skipif(os.name != "nt", reason="NTFS junction regression")
def test_disk_monitor_does_not_follow_junctions_or_overrun_deadline(tmp_path):
    monitored = tmp_path / "monitored"
    outside = tmp_path / "outside"
    monitored.mkdir()
    outside.mkdir()
    (monitored / "legitimate").write_bytes(b"ok")
    (outside / "private").write_bytes(b"outside-data")
    for name, target in (("external", outside), ("loop", monitored)):
        link = monitored / name
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-Command",
                f"New-Item -ItemType Junction -Path '{link}' -Target '{target}' | Out-Null",
            ],
            check=True,
        )
    try:
        assert _directory_size(monitored) == 2
        assert _directory_size(monitored / "external") == 0
        assert _directory_size(monitored, deadline=time.monotonic() - 1) == 0
    finally:
        # Remove only the junction entries, never their targets.
        os.rmdir(monitored / "external")
        os.rmdir(monitored / "loop")
