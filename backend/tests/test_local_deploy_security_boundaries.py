"""Reproduce trust-boundary issues under a local-deploy threat model.

These tests distinguish:
- untrusted plugin/package or webpage using CandleScope as a confused deputy
- the operator running their own code on their own machine

They use temporary directories and harmless marker files. They do not attempt
network exploitation or payload delivery.
"""

from __future__ import annotations

import inspect
import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.api.v1.backtests import (
    RunCreateRequest,
    StrategySmokeRequest,
    _operator_python_payload,
)
from app.api.v1 import stream_indicators
from app.api.v1.stream import indicator_stream
from app.backtest.service import BacktestService
from app.backtest.strategy.builtin import (
    BuiltinExpressionModelProvider,
    _compile_expression,
)
from app.backtest.strategy.protocol import ObservationFrame
from app.core.config import CORS_ORIGINS, HOST, RUNTIME_MODE, load_backtest_settings
from app.core.operator_origin import (
    effective_pyne_security_mode,
    effective_python_runtime_mode,
)
from app.core.python_wheel_install import host_wheel_install_command, venv_site_packages
from app.plugin_core_v2.runtime_providers.base import RuntimeInstallationRequest
from app.plugin_core_v2.runtime_providers.python import PythonModuleProvider
from app.plugin_installer_v2 import installer as installer_mod

SMA_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)


def _backtest_service(tmp_path: Path) -> BacktestService:
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    return BacktestService.start(settings, now_ms=10)


def _site_packages(venv: Path) -> Path:
    if sys.platform == "win32":
        return venv / "Lib" / "site-packages"
    lib = venv / "lib"
    return next(lib.glob("python*/site-packages"))


def _venv_python(venv: Path) -> Path:
    if sys.platform == "win32":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def test_isolated_python_still_executes_venv_pth_import_hooks(tmp_path: Path) -> None:
    """`python -I` still runs site .pth import lines. Installer checks use this."""

    venv = tmp_path / "venv"
    completed = subprocess.run(
        [sys.executable, "-m", "venv", str(venv)],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        pytest.skip(f"venv creation failed: {completed.stderr[-400:]}")
    python = _venv_python(venv)
    assert python.is_file()
    marker = tmp_path / "pth-hook-ran.txt"
    site = _site_packages(venv)
    site.mkdir(parents=True, exist_ok=True)
    (site / "pth_hook_marker.py").write_text(
        textwrap.dedent(
            f"""
            from pathlib import Path
            Path({str(marker)!r}).write_text("hook-ran", encoding="utf-8")
            """
        ),
        encoding="utf-8",
    )
    (site / "candlescope_pth_hook.pth").write_text(
        "import pth_hook_marker\n", encoding="utf-8"
    )
    probe = subprocess.run(
        [str(python), "-I", "-c", "print('ok')"],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert probe.stdout.strip() == "ok"
    assert marker.read_text(encoding="utf-8") == "hook-ran"


def _write_dist_info(site: Path, name: str, version: str) -> None:
    dist = site / f"{name}-{version}.dist-info"
    dist.mkdir(parents=True, exist_ok=True)
    (dist / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        encoding="utf-8",
    )


def _installation_with_venv(tmp_path: Path) -> tuple[Path, Path, Path]:
    installation = tmp_path / "install"
    installation.mkdir()
    wheel = installation / "payload.whl"
    wheel.write_bytes(b"PK\x05\x06" + b"\x00" * 18)
    python = installation / (
        "venv/Scripts/python.exe" if sys.platform == "win32" else "venv/bin/python"
    )
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_bytes(b"")
    site = venv_site_packages(installation)
    site.mkdir(parents=True, exist_ok=True)
    return installation, wheel, site


def test_python_verify_does_not_execute_venv_pth_hooks(tmp_path: Path) -> None:
    installation, wheel, site = _installation_with_venv(tmp_path)
    marker = tmp_path / "verify-hook-ran.txt"
    (site / "pth_hook_marker.py").write_text(
        textwrap.dedent(
            f"""
            from pathlib import Path
            Path({str(marker)!r}).write_text("hook-ran", encoding="utf-8")
            """
        ),
        encoding="utf-8",
    )
    (site / "candlescope_pth_hook.pth").write_text(
        "import pth_hook_marker\n", encoding="utf-8"
    )
    _write_dist_info(site, "demo", "1.0.0")

    def run_command(*_args, **_kwargs):
        raise AssertionError("verify_installation must not start an interpreter")

    PythonModuleProvider().verify_installation(
        RuntimeInstallationRequest(
            installation=installation,
            host_executable=Path(sys.executable),
            wheel_paths=(wheel,),
            distributions=(("demo", "1.0.0"),),
            runtime_ids=("python-main",),
        ),
        run_command,
    )
    assert not marker.exists()


def test_prepare_installs_wheels_with_host_python_target(tmp_path: Path) -> None:
    installation, wheel, site = _installation_with_venv(tmp_path)
    recorded: list[tuple[str, ...]] = []

    def run_command(command, **_kwargs):
        recorded.append(tuple(str(part) for part in command))
        _write_dist_info(site, "demo", "1.0.0")
        return b""

    PythonModuleProvider().prepare_installation(
        RuntimeInstallationRequest(
            installation=installation,
            host_executable=Path(sys.executable),
            wheel_paths=(wheel,),
            distributions=(("demo", "1.0.0"),),
            runtime_ids=("python-main",),
        ),
        run_command,
    )
    assert recorded
    venv_python = str(
        installation
        / ("venv/Scripts/python.exe" if sys.platform == "win32" else "venv/bin/python")
    )
    for command in recorded:
        assert command[0] != venv_python
        assert command[0] == str(Path(sys.executable))
    install = recorded[-1]
    assert install[:3] == (str(Path(sys.executable)), "-I", "-m")
    assert "pip" in install
    assert "--target" in install
    expected = host_wheel_install_command(
        Path(sys.executable), site, (wheel,)
    )
    assert install == expected


def test_install_prepares_python_runtime_before_probe() -> None:
    source = inspect.getsource(installer_mod.PlatformPluginInstaller._create_installation)
    prepare_at = source.find("_prepare_runtime_providers")
    probe_at = source.find("_run_probe")
    assert prepare_at != -1 and probe_at != -1
    assert prepare_at < probe_at
    run_command = inspect.getsource(installer_mod._run_command)
    assert "subprocess.run" in run_command
    assert "sandbox" not in run_command.lower()


def test_untrusted_probe_sandbox_does_not_cover_earlier_verify_commands() -> None:
    probe = inspect.getsource(installer_mod.PlatformPluginInstaller._run_probe)
    assert 'trust_level == "untrusted"' in probe
    assert "--sandbox-policies" in probe
    verify = inspect.getsource(installer_mod.PlatformPluginInstaller._verify_runtime_providers)
    assert "_run_command" in verify
    assert "sandbox" not in verify.lower()


def test_host_authority_modes_require_trusted_origin() -> None:
    assert effective_python_runtime_mode(
        "TRUSTED_LOCAL", True, trusted=False
    ) == ("SANDBOXED_LOCAL", False)
    assert effective_python_runtime_mode(
        "TRUSTED_LOCAL", True, trusted=True
    ) == ("TRUSTED_LOCAL", True)
    assert effective_pyne_security_mode("unsafe", trusted=False) == "safe"
    assert effective_pyne_security_mode("unsafe", trusted=True) == "unsafe"
    assert effective_pyne_security_mode("research", trusted=False) == "research"

    smoke = StrategySmokeRequest(
        dataset_id="local-0123456789abcdef0123456789abcdef",
        snapshot_hash="sha256:" + "ab" * 32,
        start_time_ms=1,
        end_time_ms=2,
        python_runtime_mode="TRUSTED_LOCAL",
        python_trusted_confirmed=True,
    )
    run = RunCreateRequest.model_validate(
        {
            "strategy_revision_id": "rev-1",
            "dataset_id": "local-0123456789abcdef0123456789abcdef",
            "data_epoch": "sha256:" + "ab" * 32,
            "snapshot_hash": "sha256:" + "cd" * 32,
            "fidelity_mode": "BAR_APPROX",
            "start_time_ms": 1,
            "end_time_ms": 2,
            "python_runtime_mode": "TRUSTED_LOCAL",
            "python_trusted_confirmed": True,
        }
    )
    assert smoke.python_trusted_confirmed is True
    assert run.python_trusted_confirmed is True

    from starlette.requests import Request

    def _request(origin: str | None) -> Request:
        headers = []
        if origin is not None:
            headers.append((b"origin", origin.encode("ascii")))
        return Request(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/",
                "raw_path": b"/",
                "query_string": b"",
                "headers": headers,
                "client": ("127.0.0.1", 1),
                "server": ("127.0.0.1", 80),
            }
        )

    dumped = smoke.model_dump()
    clamped = _operator_python_payload(_request("https://evil.example"), dumped)
    assert clamped["python_runtime_mode"] == "SANDBOXED_LOCAL"
    assert clamped["python_trusted_confirmed"] is False
    allowed = next(iter(CORS_ORIGINS))
    trusted = _operator_python_payload(_request(allowed), dumped)
    assert trusted["python_runtime_mode"] == "TRUSTED_LOCAL"
    assert trusted["python_trusted_confirmed"] is True


def test_pyne_bridge_still_honors_mode_after_server_clamp() -> None:
    runtime = (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "candlescope-plugin-pyne"
        / "src"
        / "candlescope_plugin_pyne"
        / "runtime.py"
    ).read_text(encoding="utf-8")
    assert "security_mode=security_mode or settings.security_mode" in runtime
    source = inspect.getsource(indicator_stream)
    assert "await websocket.accept()" in source
    subscribe = Path(stream_indicators.__file__ or "").read_text(encoding="utf-8")
    assert "trusted_origin" in subscribe


def test_cors_does_not_prevent_cross_origin_simple_post() -> None:
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    executed = {"count": 0}

    @app.post("/mutate")
    def mutate() -> dict[str, bool]:
        executed["count"] += 1
        return {"ok": True}

    client = TestClient(app)
    response = client.post(
        "/mutate",
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert executed["count"] == 1
    assert response.headers.get("access-control-allow-origin") != "https://evil.example"


def test_websocket_accepts_foreign_origin_before_any_app_check() -> None:
    app = FastAPI()

    @app.websocket("/indicators")
    async def accept_first(websocket: WebSocket) -> None:
        await websocket.accept()
        origin = websocket.headers.get("origin")
        await websocket.send_json({"acceptedOrigin": origin})
        await websocket.close()

    client = TestClient(app)
    with client.websocket_connect(
        "/indicators",
        headers={"Origin": "https://evil.example"},
    ) as socket:
        payload = socket.receive_json()
    assert payload["acceptedOrigin"] == "https://evil.example"


def test_expression_model_allows_power_without_intermediate_budget() -> None:
    _compile_expression("(2 ** 20) ** 8")
    provider = BuiltinExpressionModelProvider()
    provider.prepare({"source": "(2 ** 10) ** 4", "parameters": {}})
    frame = ObservationFrame(
        run_id="expr",
        sequence=1,
        event_time_ms=60_000,
        watermark_ms=60_000,
        phase="STEP",
        market={"symbol": "BTCUSDT"},
        input_hash="sha256:1",
        bar={"open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
    )
    score = provider._score(frame)
    assert score == (2 ** 10) ** 4
    builtin_source = Path(
        sys.modules["app.backtest.strategy.builtin"].__file__ or ""
    ).read_text(encoding="utf-8")
    assert "ast.Pow" in builtin_source
    assert "bit_length" not in builtin_source


def test_python_revision_executes_bundle_id_not_claimed_hash(tmp_path: Path) -> None:
    reviewed = tmp_path / "reviewed"
    executed = tmp_path / "executed"
    shutil.copytree(SMA_FIXTURE, reviewed)
    shutil.copytree(SMA_FIXTURE, executed)
    executed_source = (executed / "strategy.py").read_text(encoding="utf-8")
    (executed / "strategy.py").write_text(
        executed_source.replace("\r\n", "\n") + "# executed-not-reviewed\n",
        encoding="utf-8",
        newline="\n",
    )
    service = _backtest_service(tmp_path / "bt")
    try:
        reviewed_bundle = service.create_python_strategy_bundle(
            directory=str(reviewed), now_ms=11
        )
        executed_bundle = service.create_python_strategy_bundle(
            directory=str(executed), now_ms=12
        )
        assert reviewed_bundle["bundle_hash"] != executed_bundle["bundle_hash"]
        identity = {
            "bundle_id": executed_bundle["bundle_id"],
            "bundle_hash": reviewed_bundle["bundle_hash"],
            "manifest_hash": reviewed_bundle["manifest_hash"],
            "source_hash": reviewed_bundle["source_hash"],
            "sdk_hash": reviewed_bundle["sdk_hash"],
            "entrypoint": "strategy:Strategy",
            "signalClock": "BAR_CLOSE",
            "outputModes": ["TARGET_POSITION"],
        }
        revision = service.create_strategy_revision(
            {
                "name": "hash-mismatch",
                "language": "PYTHON_SOURCE",
                "source_text": json.dumps(identity, sort_keys=True),
                "parameter_schema": [],
            },
            now_ms=13,
        )
        provider = service.build_python_host_provider(revision["revision_id"])
        assert Path(provider.bundle_dir).resolve() == Path(
            str(service.repository.get_strategy_bundle(executed_bundle["bundle_id"])["store_path"])
        ).resolve()
        source = inspect.getsource(BacktestService.build_python_host_provider)
        assert "get_strategy_bundle" in source
        assert "source_hash" not in source
    finally:
        service.shutdown()


def test_documented_live_host_default_is_all_interfaces() -> None:
    if RUNTIME_MODE != "LOCAL_OFFLINE":
        assert HOST in {"0.0.0.0", "127.0.0.1"}
    config_text = Path(sys.modules["app.core.config"].__file__ or "").read_text(
        encoding="utf-8"
    )
    assert 'os.getenv("CANDLE_HOST", "0.0.0.0")' in config_text
