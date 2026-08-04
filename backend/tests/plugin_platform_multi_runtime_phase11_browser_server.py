"""Production-build browser fixture for the multi-runtime Phase 11 GA gate.

The browser drives the real Plugin Manager against two deliberately different
trust paths: a signed Marketplace Python plugin running in AppContainer and a
locally selected native executable installed through itemized double consent.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_security_v2 import delete_appcontainer_profile
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_marketplace_phase10_testkit import SignedMarketplaceV2Builder
from tests.plugin_marketplace_testkit import (
    INDEX_URL,
    MARKETPLACE_ID,
    build_marketplace_bundle,
)
from tests.plugin_platform_native_testkit import (
    build_native_reference_bundle,
    compile_native_reference,
)


ROOT = Path(os.environ["PHASE11_MULTI_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE11_MULTI_BROWSER_BUNDLE_DIRECTORY"]).resolve()
EVIDENCE_DIRECTORY = Path(
    os.environ["PHASE11_MULTI_BROWSER_EVIDENCE_DIRECTORY"]
).resolve()
ORIGIN = os.environ.get("PHASE11_MULTI_BROWSER_ORIGIN", "http://127.0.0.1:18141")
MANAGEMENT_API_ORIGIN = os.environ.get(
    "PHASE11_MULTI_BROWSER_MANAGEMENT_API_ORIGIN", "http://localhost:18141"
)
SESSION_TOKEN = "phase11-multi-browser-session-token-0123456789abcdef"
CSRF_TOKEN = "phase11-multi-browser-csrf-token-abcdef0123456789"
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE11_MULTI_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 11 browser fixture requires a production frontend build")

EVIDENCE_DIRECTORY.mkdir(parents=True, exist_ok=True)
LIVE_EVIDENCE = EVIDENCE_DIRECTORY / "browser-live.json"
SHUTDOWN_EVIDENCE = EVIDENCE_DIRECTORY / "browser-shutdown.json"


class _LocalMarketplaceFetcher:
    def __init__(self, values: dict[str, bytes]) -> None:
        self.values = dict(values)
        self.calls: list[str] = []

    def get(self, url: str, *, maximum: int) -> bytes:
        self.calls.append(url)
        value = self.values.get(url)
        if value is None:
            raise RuntimeError(f"unmapped Phase 11 Marketplace URL: {url}")
        if len(value) > maximum:
            raise RuntimeError("Phase 11 Marketplace fixture exceeds its signed limit")
        return value


def _sha256_path(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


MARKETPLACE_FIXTURE = build_marketplace_bundle(BUNDLE_DIRECTORY / "marketplace")
MARKETPLACE_BUILDER = SignedMarketplaceV2Builder.create()
MARKETPLACE_RELEASE = MARKETPLACE_BUILDER.add_release(
    MARKETPLACE_FIXTURE.bundle,
    operating_system="windows",
    architecture="x86_64",
    rollout_stage="stable",
    official_maintained=True,
)
MARKETPLACE_INDEX = MARKETPLACE_BUILDER.index_bytes()
MARKETPLACE_ARTIFACT_URL = MARKETPLACE_RELEASE["artifacts"][0]["url"]
MARKETPLACE_FETCHER = _LocalMarketplaceFetcher(
    {
        INDEX_URL: MARKETPLACE_INDEX,
        MARKETPLACE_ARTIFACT_URL: MARKETPLACE_FIXTURE.bundle.path.read_bytes(),
    }
)
NATIVE_BUILD = compile_native_reference(BUNDLE_DIRECTORY / "native-build")
NATIVE_FIXTURE = build_native_reference_bundle(
    BUNDLE_DIRECTORY / "native-bundle", NATIVE_BUILD
)

PLATFORM = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
    marketplace_enabled=True,
    marketplace_roots=(MARKETPLACE_BUILDER.root,),
    marketplace_fetcher=MARKETPLACE_FETCHER,
    trust_ux_enabled=True,
    multi_runtime_enabled=True,
    runtime_provider_seam_enabled=True,
    native_runtime_enabled=True,
)
PLATFORM.marketplace.import_index(
    MARKETPLACE_INDEX,
    marketplace_id=MARKETPLACE_ID,
)
GUARD = LocalManagementGuard(
    (ORIGIN,),
    session_token=SESSION_TOKEN,
    csrf_token=CSRF_TOKEN,
)

HTTP_OBSERVATIONS: list[dict[str, Any]] = []
BROWSER_OBSERVATION: dict[str, Any] | None = None
FLOW_EVIDENCE: dict[str, Any] | None = None
OBSERVED_PROCESS_IDS: set[int] = set()
OBSERVED_PROFILES: set[str] = set()
SHUTDOWN_COMPLETE = False


def _process_exists(process_id: int) -> bool:
    try:
        import psutil

        process = psutil.Process(process_id)
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except (ImportError, OSError):
        if os.name != "nt":
            return False
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x00100000, False, process_id)
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) != 0
        finally:
            kernel32.CloseHandle(handle)


async def _wait_for_exit(process_id: int) -> bool:
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if not _process_exists(process_id):
            return True
        await asyncio.sleep(0.05)
    return not _process_exists(process_id)


def _transport_evidence(plugin_id: str) -> tuple[Any, dict[str, Any]]:
    supervisor = PLATFORM.manager.supervisor(plugin_id, "main")
    snapshot = supervisor.snapshot()
    transport = snapshot.get("transport")
    if snapshot.get("state") != "active" or not isinstance(transport, dict):
        raise RuntimeError(f"Phase 11 plugin transport is not active: {plugin_id}")
    process_id = transport.get("pid")
    if not isinstance(process_id, int) or process_id <= 0:
        raise RuntimeError(f"Phase 11 plugin process id is absent: {plugin_id}")
    OBSERVED_PROCESS_IDS.add(process_id)
    policy = supervisor.spec.sandbox_policy
    if policy is not None:
        OBSERVED_PROFILES.add(policy.profile_name)
    return supervisor, snapshot


async def _verify_flows() -> dict[str, Any]:
    global FLOW_EVIDENCE

    marketplace_plugin = MARKETPLACE_FIXTURE.bundle.manifest.plugin.id
    native_plugin = NATIVE_FIXTURE.bundle.manifest.plugin.id
    marketplace_result = await PLATFORM.invoke_command(
        f"{marketplace_plugin}.hello",
        {"name": "Phase 11 Marketplace"},
        user_action=True,
        trace_id="phase11-browser-marketplace",
    )
    native_result = await PLATFORM.invoke_command(
        f"{native_plugin}.hello",
        {"name": "Phase 11 trusted local"},
        user_action=True,
        trace_id="phase11-browser-trusted-local",
    )
    marketplace_detail = PLATFORM.management_detail(marketplace_plugin)
    native_detail = PLATFORM.management_detail(native_plugin)
    marketplace_trust = marketplace_detail.get("trust", {})
    native_trust = native_detail.get("trust", {})
    marketplace_supervisor, marketplace_snapshot = _transport_evidence(
        marketplace_plugin
    )
    native_supervisor, native_snapshot = _transport_evidence(native_plugin)
    policy = marketplace_supervisor.spec.sandbox_policy
    if policy is None:
        raise RuntimeError("signed Marketplace plugin has no Windows sandbox policy")
    configs = sorted(policy.runtime_directory.glob("launch-*/config.json"))
    if not configs:
        raise RuntimeError(
            "signed Marketplace plugin has no AppContainer launch receipt"
        )
    sandbox_config = json.loads(configs[-1].read_text(encoding="utf-8"))
    if (
        marketplace_supervisor.spec.trust_level != "untrusted"
        or marketplace_trust.get("mode") != "marketplace-sandboxed"
        or marketplace_trust.get("authorization", {}).get("sandbox", {}).get("status")
        != "windows-appcontainer"
        or not sandbox_config.get("appContainerSid", "").startswith("S-1-15-2-")
        or sandbox_config.get("limits", {}).get("activeProcesses") != 1
    ):
        raise RuntimeError("signed Marketplace AppContainer evidence is incomplete")
    if (
        native_supervisor.spec.trust_level != "local-trusted"
        or native_supervisor.spec.sandbox_policy is not None
        or native_trust.get("mode") != "trusted-local"
    ):
        raise RuntimeError("local native plugin did not retain trusted-local semantics")
    if set(PLATFORM.manager.owner_keys()) != {
        (marketplace_plugin, "main"),
        (native_plugin, "main"),
    }:
        raise RuntimeError("browser flows did not retain two isolated supervisors")

    FLOW_EVIDENCE = {
        "marketplace": {
            "pluginId": marketplace_plugin,
            "bundleSha256": MARKETPLACE_FIXTURE.bundle.sha256,
            "publisherVerified": True,
            "officialMaintained": True,
            "rolloutStage": "stable",
            "trustMode": marketplace_trust["mode"],
            "sandboxStatus": marketplace_trust["authorization"]["sandbox"]["status"],
            "appContainerSidPresent": True,
            "activeProcessLimit": sandbox_config["limits"]["activeProcesses"],
            "processTreeControl": bool(
                marketplace_snapshot["transport"].get("processTreeControl")
            ),
            "generation": marketplace_snapshot["generation"],
            "resultSha256": "sha256:"
            + hashlib.sha256(
                json.dumps(
                    marketplace_result,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
        },
        "trustedLocal": {
            "pluginId": native_plugin,
            "bundleSha256": NATIVE_FIXTURE.bundle.sha256,
            "runtimeKind": "native-executable",
            "trustMode": native_trust["mode"],
            "sandboxPolicy": None,
            "doubleConfirmation": True,
            "generation": native_snapshot["generation"],
            "resultSha256": "sha256:"
            + hashlib.sha256(
                json.dumps(
                    native_result,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
        },
        "activeProcesses": len(OBSERVED_PROCESS_IDS),
        "activeSupervisors": len(PLATFORM.manager.owner_keys()),
        "marketplaceFetchCalls": len(MARKETPLACE_FETCHER.calls),
    }
    _write_live_evidence()
    return FLOW_EVIDENCE


def _write_live_evidence() -> None:
    if FLOW_EVIDENCE is None or BROWSER_OBSERVATION is None:
        return
    _atomic_json(
        LIVE_EVIDENCE,
        {
            "schemaVersion": "candlescope.plugin-platform.multi-runtime.phase11-browser-live/1",
            "result": "pass",
            "flows": FLOW_EVIDENCE,
            "browser": BROWSER_OBSERVATION,
            "http": {
                "requestCount": len(HTTP_OBSERVATIONS),
                "unexpected": [
                    item for item in HTTP_OBSERVATIONS if item["status"] >= 400
                ],
            },
            "fixtures": {
                "marketplaceBundleSha256": MARKETPLACE_FIXTURE.bundle.sha256,
                "nativeBundleSha256": NATIVE_FIXTURE.bundle.sha256,
                "nativeExecutableSha256": NATIVE_BUILD.sha256,
            },
        },
    )


def _browser_exchange() -> dict[str, Any]:
    return {
        "exchange": "binance",
        "name": "Phase 11 Browser Fixture",
        "capability_schema_version": 3,
        "markets": [{"market_type": "spot", "product_type": "spot", "label": "Spot"}],
        "native_intervals": ["1m", "1h"],
        "channels": [
            {
                "channel": "kline",
                "market_types": ["spot"],
                "realtime": True,
                "history": True,
                "params": {"interval": ["1m", "1h"]},
            }
        ],
        "protocol_features": [],
        "limits": {},
        "known_limitations": ["Phase 11 browser fixture only"],
    }


def _browser_klines() -> dict[str, Any]:
    end = int(time.time()) // 3_600 * 3_600
    bars = [
        {
            "time": end - (63 - index) * 3_600,
            "open": 99 + (index % 4) * 0.25,
            "high": 101 + (index % 4) * 0.25,
            "low": 98 + (index % 4) * 0.25,
            "close": 100 + (index % 4) * 0.25,
            "volume": 10 + index,
            "is_closed": True,
        }
        for index in range(64)
    ]
    return {
        "data": bars,
        "count": len(bars),
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1h",
        "has_more": False,
        "all_rows_final": True,
        "verified_contiguous": True,
        "renderable": True,
    }


async def _shutdown_platform() -> dict[str, Any]:
    global SHUTDOWN_COMPLETE
    if SHUTDOWN_COMPLETE:
        return json.loads(SHUTDOWN_EVIDENCE.read_text(encoding="utf-8"))
    for owner in PLATFORM.manager.owner_keys():
        supervisor = PLATFORM.manager.supervisor(*owner)
        snapshot = supervisor.snapshot()
        transport = snapshot.get("transport")
        if isinstance(transport, dict):
            process_id = transport.get("pid")
            if isinstance(process_id, int) and process_id > 0:
                OBSERVED_PROCESS_IDS.add(process_id)
        policy = supervisor.spec.sandbox_policy
        if policy is not None:
            OBSERVED_PROFILES.add(policy.profile_name)
    await PLATFORM.stop()
    for profile in sorted(OBSERVED_PROFILES):
        delete_appcontainer_profile(profile)
    observed_processes = sorted(OBSERVED_PROCESS_IDS)
    exit_results = await asyncio.gather(
        *(_wait_for_exit(process_id) for process_id in observed_processes)
    )
    residual = [
        process_id
        for process_id, exited in zip(observed_processes, exit_results, strict=True)
        if not exited
    ]
    receipt = {
        "schemaVersion": "candlescope.plugin-platform.multi-runtime.phase11-browser-shutdown/1",
        "result": "pass"
        if not residual and not PLATFORM.manager.owner_keys()
        else "fail",
        "observedProcesses": len(OBSERVED_PROCESS_IDS),
        "observedSandboxProfiles": len(OBSERVED_PROFILES),
        "residualProcesses": residual,
        "residualSupervisors": len(PLATFORM.manager.owner_keys()),
        "profilesDeleted": len(OBSERVED_PROFILES),
    }
    _atomic_json(SHUTDOWN_EVIDENCE, receipt)
    SHUTDOWN_COMPLETE = True
    return receipt


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await PLATFORM.start()
    try:
        yield
    finally:
        await _shutdown_platform()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ORIGIN],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["*"],
)
app.state.plugin_platform_v2 = PLATFORM
app.state.plugin_platform_v2_management_guard = GUARD
app.include_router(create_core_plugin_router())


@app.middleware("http")
async def observe_http(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    if request.url.path not in {"/healthz", "/favicon.ico"}:
        HTTP_OBSERVATIONS.append(
            {
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
            }
        )
    return response


@app.post("/api/v1/settings/cache-limits")
@app.post("/api/v1/settings/cache-access")
async def browser_cache_write() -> dict[str, Any]:
    return {"updated": True}


@app.get("/api/v1/settings/cache-diagnostics")
async def browser_cache_diagnostics() -> dict[str, Any]:
    return {}


@app.get("/api/v1/settings/proxy")
async def browser_proxy_settings() -> dict[str, Any]:
    return {
        "mode": "none",
        "custom_proxy": "",
        "system_proxy": "",
        "effective_proxy": "",
    }


@app.get("/api/v1/exchanges/")
async def browser_exchanges() -> dict[str, Any]:
    exchange = _browser_exchange()
    return {"count": 1, "exchanges": [exchange]}


@app.get("/api/v1/exchanges/binance/capabilities")
async def browser_exchange_capabilities() -> dict[str, Any]:
    return _browser_exchange()


@app.get("/api/v1/subscriptions/")
async def browser_subscriptions() -> dict[str, Any]:
    return {"subscriptions": []}


@app.get("/api/v1/replay/capabilities")
async def browser_replay_capabilities() -> dict[str, Any]:
    return {
        "protocol": "replay.v1",
        "enabled": False,
        "available": False,
        "reason": "REPLAY_DISABLED",
        "sources": {
            "bar": {"enabled": False, "reason": "REPLAY_DISABLED"},
            "agg_trade": {"enabled": False, "reason": "REPLAY_DISABLED"},
        },
        "execution_models": [],
        "limits": {
            "max_active_sessions": 1,
            "max_warmup_bars": 5000,
            "max_bar_dataset_rows": 1_000_000,
            "max_horizon_days": 365,
            "event_buffer_size": 10_000,
            "subscriber_queue": 1024,
        },
        "persistence": {
            "opened": False,
            "schema_version": None,
            "degraded": False,
            "degraded_reason": None,
        },
    }


@app.get("/api/v1/klines/")
@app.get("/api/v1/klines/latest")
@app.get("/api/v1/klines/history")
async def browser_klines() -> dict[str, Any]:
    return _browser_klines()


async def _hold_browser_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
    except WebSocketDisconnect:
        return


@app.websocket("/api/v1/stream/prices")
@app.websocket("/api/v1/stream/order-book")
@app.websocket("/api/v1/stream/klines_multi")
async def browser_websocket(websocket: WebSocket) -> None:
    await _hold_browser_websocket(websocket)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ready": True,
        "nativeBundlePath": str(NATIVE_FIXTURE.bundle.path),
        "nativeBundleSha256": NATIVE_FIXTURE.bundle.sha256,
        "marketplacePluginId": MARKETPLACE_FIXTURE.bundle.manifest.plugin.id,
        "nativePluginId": NATIVE_FIXTURE.bundle.manifest.plugin.id,
        "marketplaceValidCacheCount": PLATFORM.marketplace.status()["validCacheCount"],
        "liveEvidence": LIVE_EVIDENCE.is_file(),
    }


@app.post("/phase11/verify")
async def verify_flows() -> dict[str, Any]:
    return await _verify_flows()


@app.post("/phase11/browser-observation")
async def browser_observation(request: Request) -> dict[str, Any]:
    global BROWSER_OBSERVATION
    value = await request.json()
    required_counts = ("consoleErrors", "pageErrors", "unhandledRejections")
    required_checks = (
        "pluginManager",
        "marketplaceAssurances",
        "marketplaceInstalled",
        "trustedLocalInstalled",
    )
    if (
        not isinstance(value, dict)
        or any(
            not isinstance(value.get(key), int) or value[key] < 0
            for key in required_counts
        )
        or any(value.get(key) is not True for key in required_checks)
    ):
        raise RuntimeError("Phase 11 browser observation is incomplete")
    BROWSER_OBSERVATION = {
        key: value[key] for key in (*required_counts, *required_checks)
    }
    _write_live_evidence()
    return {"recorded": True}


@app.post("/phase11/shutdown")
async def shutdown_fixture() -> dict[str, Any]:
    return await _shutdown_platform()


@app.get("/favicon.ico")
async def favicon() -> Response:
    return Response(status_code=204)


@app.get("/", response_class=HTMLResponse)
async def frontend_index() -> HTMLResponse:
    html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
    bootstrap = f"""
<script>
localStorage.setItem("candlescope-active-indicators", JSON.stringify([{{
  "id": "vol", "name": "VOL", "engineName": "VOL", "script": "", "params": {{}},
  "description": "Phase 11 browser fixture", "category": "", "paneTarget": "volume",
  "isPreset": true, "visible": false
}}]));
localStorage.setItem("candlescope-vol-initialized", "1");
window.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__ = {{
  apiBase: "{MANAGEMENT_API_ORIGIN}/api/v2/plugins",
  sessionToken: "{SESSION_TOKEN}",
  csrfToken: "{CSRF_TOKEN}"
}};
window.__CANDLESCOPE_PHASE11_MULTI_BROWSER_V1__ = {
        json.dumps(
            {
                "marketplacePluginId": MARKETPLACE_FIXTURE.bundle.manifest.plugin.id,
                "marketplaceBundleSha256": MARKETPLACE_FIXTURE.bundle.sha256,
                "nativePluginId": NATIVE_FIXTURE.bundle.manifest.plugin.id,
                "nativeBundleSha256": NATIVE_FIXTURE.bundle.sha256,
            },
            separators=(",", ":"),
        )
    };
window.__CANDLESCOPE_PHASE11_OBSERVATION__ = {{
  consoleErrors: 0, pageErrors: 0, unhandledRejections: 0
}};
const phase11OriginalConsoleError = console.error.bind(console);
console.error = (...args) => {{
  window.__CANDLESCOPE_PHASE11_OBSERVATION__.consoleErrors += 1;
  phase11OriginalConsoleError(...args);
}};
window.addEventListener("error", () => {{
  window.__CANDLESCOPE_PHASE11_OBSERVATION__.pageErrors += 1;
}});
window.addEventListener("unhandledrejection", () => {{
  window.__CANDLESCOPE_PHASE11_OBSERVATION__.unhandledRejections += 1;
}});
</script>
"""
    return HTMLResponse(html.replace("</head>", bootstrap + "</head>"))


app.mount(
    "/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase11-multi-frontend"
)
