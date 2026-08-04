from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import hashlib
import io
import json
import os
import zipfile
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase11 as phase11
from scripts import plugin_platform_multi_runtime_phase11_browser_evidence as browser
from scripts import plugin_platform_multi_runtime_phase11_regression as regression
from scripts import plugin_platform_multi_runtime_phase11_sdk as sdk
from scripts import plugin_platform_multi_runtime_phase11_soak as soak
from scripts import plugin_platform_multi_runtime_phase11_support as support


def _write_wheel(path: Path, *, corrupt_record: bool = False) -> None:
    payloads = {
        "candlescope_plugin_sdk/__init__.py": b'__version__ = "0.2.0"\n',
        "candlescope_plugin_sdk/runtime.py": b"",
        "candlescope_plugin_sdk/server.py": b"",
        "candlescope_plugin_sdk/platform_v2/__init__.py": b"",
        "candlescope_plugin_sdk/platform_v2/schemas/manifest-v2.schema.json": b"{}\n",
        "candlescope_plugin_sdk/platform_v2/schemas/manifest-v3.schema.json": b"{}\n",
        "candlescope_plugin_sdk-0.2.0.dist-info/METADATA": (
            b"Metadata-Version: 2.4\n"
            b"Name: candlescope-plugin-sdk\n"
            b"Version: 0.2.0\n"
            b"Requires-Python: >=3.11\n"
            b"License-Expression: GPL-3.0-only\n"
            b"Description-Content-Type: text/markdown\n\n"
            b"# CandleScope Plugin SDK\n"
        ),
        "candlescope_plugin_sdk-0.2.0.dist-info/WHEEL": (
            b"Wheel-Version: 1.0\n"
            b"Generator: candlescope-phase11-test\n"
            b"Root-Is-Purelib: true\n"
            b"Tag: py3-none-any\n"
        ),
    }
    record_name = "candlescope_plugin_sdk-0.2.0.dist-info/RECORD"
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    for name, payload in payloads.items():
        encoded = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).rstrip(
            b"="
        )
        digest = "sha256=" + encoded.decode("ascii")
        if corrupt_record and name == "candlescope_plugin_sdk/runtime.py":
            digest = "sha256=invalid"
        writer.writerow((name, digest, len(payload)))
    writer.writerow((record_name, "", ""))
    payloads[record_name] = output.getvalue().encode("utf-8")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in payloads.items():
            archive.writestr(name, payload)


def _browser_receipts(root: Path) -> tuple[Path, Path, Path, Path]:
    live = root / "live.json"
    shutdown = root / "shutdown.json"
    screenshot = root / "plugin-manager.png"
    trace = root / "plugin-manager.trace"
    screenshot.write_bytes(b"real-headed-screenshot")
    trace.write_bytes(b"real-headed-trace")
    live.write_text(
        json.dumps(
            {
                "schemaVersion": (
                    "candlescope.plugin-platform.multi-runtime.phase11-browser-live/1"
                ),
                "result": "pass",
                "browser": {
                    "consoleErrors": 0,
                    "pageErrors": 0,
                    "unhandledRejections": 0,
                    "pluginManager": True,
                    "marketplaceAssurances": True,
                    "marketplaceInstalled": True,
                    "trustedLocalInstalled": True,
                },
                "flows": {
                    "marketplace": {
                        "trustMode": "marketplace-sandboxed",
                        "sandboxStatus": "windows-appcontainer",
                        "appContainerSidPresent": True,
                        "activeProcessLimit": 1,
                        "processTreeControl": True,
                    },
                    "trustedLocal": {
                        "trustMode": "trusted-local",
                        "runtimeKind": "native-executable",
                        "doubleConfirmation": True,
                        "sandboxPolicy": None,
                    },
                    "activeProcesses": 2,
                    "activeSupervisors": 2,
                },
                "http": {"requestCount": 17, "unexpected": []},
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    shutdown.write_text(
        json.dumps(
            {
                "schemaVersion": (
                    "candlescope.plugin-platform.multi-runtime.phase11-browser-shutdown/1"
                ),
                "result": "pass",
                "observedProcesses": [101, 102],
                "observedSandboxProfiles": ["CandleScope.Plugin.test"],
                "profilesDeleted": ["CandleScope.Plugin.test"],
                "residualProcesses": [],
                "residualSupervisors": 0,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    return live, shutdown, screenshot, trace


def test_release_soak_requires_four_hours_before_starting_runtime(
    tmp_path: Path,
) -> None:
    arguments = argparse.Namespace(
        allow_short=False,
        duration_seconds=soak.RELEASE_MINIMUM_SECONDS - 0.001,
        invoke_seconds=10.0,
        sample_seconds=60.0,
        output=tmp_path / "soak.json",
        progress=None,
        jre_evidence=tmp_path / "unused-jre",
        node_evidence=tmp_path / "unused-node",
        wasmtime_evidence=tmp_path / "unused-wasmtime",
    )
    with pytest.raises(soak.SoakError, match="at least 14400 real seconds"):
        asyncio.run(soak.run_soak(arguments))
    assert soak.RELEASE_MINIMUM_SECONDS == 4 * 60 * 60


@pytest.mark.skipif(os.name != "nt", reason="Phase 11 GA target is Windows")
def test_windows_process_metrics_need_no_optional_psutil() -> None:
    metrics = support._windows_process_metrics(os.getpid())
    assert metrics["pid"] == os.getpid()
    assert metrics["rssBytes"] > 0
    assert metrics["vmsBytes"] > 0
    assert metrics["handles"] > 0
    assert metrics["threads"] > 0


@pytest.mark.skipif(os.name != "nt", reason="Phase 11 GA target is Windows")
def test_windows_metrics_do_not_pollute_earlier_gate_ctypes_signatures() -> None:
    from app.data_engine.data_manager import runtime_pressure
    from scripts import plugin_platform_multi_runtime_phase2 as phase2
    from scripts import plugin_platform_multi_runtime_phase3 as phase3

    memory = runtime_pressure._windows_process_memory()
    support._windows_process_metrics(os.getpid())

    assert memory["available"] is True
    assert phase2._working_set_bytes(os.getpid()) is not None
    assert phase3._working_set_bytes(os.getpid()) is not None


def test_recorded_real_faults_cover_crash_hang_and_cancel() -> None:
    faults = phase11._recorded_fault_codes()
    assert faults["crash"] == "PLUGIN_PLATFORM_EXITED"
    assert faults["hang"] == "PLUGIN_PLATFORM_TIMEOUT"
    assert faults["cancel"] == "PLUGIN_WASM_CANCELLED"


def test_python_sdk_wheel_record_and_metadata_are_verified(tmp_path: Path) -> None:
    valid = tmp_path / "valid.whl"
    invalid = tmp_path / "invalid.whl"
    _write_wheel(valid)
    _write_wheel(invalid, corrupt_record=True)
    result = sdk._wheel_archive_check(valid)
    assert result["result"] == "pass"
    assert result["recordHashesVerified"] == result["recordEntries"] - 1
    with pytest.raises(sdk.SdkGateError, match="RECORD mismatch"):
        sdk._wheel_archive_check(invalid)


def test_browser_evidence_requires_headed_flows_and_zero_residue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live, shutdown, screenshot, trace = _browser_receipts(tmp_path)
    output = tmp_path / "browser.json"
    monkeypatch.setattr(browser, "_git_head", lambda: "a" * 40)
    result = browser.finalize(
        argparse.Namespace(
            live=live,
            shutdown=shutdown,
            screenshot=screenshot,
            trace=trace,
            output=output,
        )
    )
    assert result["headed"] is True
    assert result["productionBuild"] is True
    assert result["cleanup"]["residualProcesses"] == 0
    shutdown_value = json.loads(shutdown.read_text(encoding="utf-8"))
    shutdown_value["residualProcesses"] = [102]
    shutdown.write_text(json.dumps(shutdown_value), encoding="utf-8")
    with pytest.raises(browser.BrowserEvidenceError, match="cleanup did not converge"):
        browser.finalize(
            argparse.Namespace(
                live=live,
                shutdown=shutdown,
                screenshot=screenshot,
                trace=trace,
                output=output,
            )
        )


def test_full_regression_summary_is_strict() -> None:
    assert regression._backend_summary("1042 passed, 3 skipped in 12.34s") == {
        "passed": 1042,
        "failed": 0,
        "skipped": 3,
    }
    with pytest.raises(regression.RegressionError, match="no passed-test summary"):
        regression._backend_summary("collected 0 items")


def test_full_regression_failure_context_is_bounded_and_actionable() -> None:
    output = "\n".join(
        ["TAP version 13", "ok 1 - stable", "not ok 2 - flaky boundary"]
        + [f"detail {index}" for index in range(40)]
    )

    context = regression._failure_context(output, radius=2, limit=80)

    assert "not ok 2 - flaky boundary" in context
    assert "detail 0" in context
    assert "detail 1" in context
    assert "detail 2" not in context
    assert len(context) <= 80


def test_full_regression_uses_replay_default_off_baseline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REPLAY_ENABLED", "1")
    monkeypatch.setenv("REPLAY_AGG_TRADE_ENABLED", "1")

    environment = regression._backend_environment()

    assert environment["REPLAY_ENABLED"] == "0"
    assert environment["REPLAY_AGG_TRADE_ENABLED"] == "0"


def test_full_regression_console_json_is_legacy_console_safe() -> None:
    encoded = regression._console_json({"result": "pass", "tail": "✓ 构建完成"})

    assert encoded.isascii()
    assert "\\u2713" in encoded
    assert "\\u6784\\u5efa\\u5b8c\\u6210" in encoded
    assert json.loads(encoded) == {"result": "pass", "tail": "✓ 构建完成"}


def test_multi_runtime_startup_mode_requires_an_explicit_success_result() -> None:
    multi = {"cleanup": {"residualProcesses": 0, "residualSupervisors": 0}}

    startup = phase11._completed_startup_matrix(
        {"result": "pass"},
        {"result": "pass"},
        {"result": "pass"},
        multi,
    )

    assert set(startup) == {
        "no-plugin",
        "v1-only",
        "v2-Python-only",
        "multi-runtime",
    }
    assert startup["multi-runtime"]["result"] == "pass"
    assert "result" not in multi
