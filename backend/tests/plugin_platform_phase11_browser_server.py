"""Real browser fixture for Paper, WP-E, and explicit fake-backend WP-F."""

from __future__ import annotations

import base64
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_live_v2 import (
    OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
    LiveBrokerController,
    LivePublisherTrustStore,
)
from app.plugin_live_v2.protocol import (
    LIVE_BROKER_PROTOCOL_VERSION,
    METHOD_ACCOUNT_DISCOVER,
    METHOD_AUDIT_EXPORT_PAGE,
    METHOD_AUTHORITY_REVOKE,
    METHOD_BOOTSTRAP,
    METHOD_CONFIRMATION_DESCRIBE,
    METHOD_CONFIRMATION_ISSUE,
    METHOD_CONFIRMATION_PREVIEW,
    METHOD_CONFIRMATION_REVOKE,
    METHOD_CONTROL_KILL,
    METHOD_CONTROL_SET,
    METHOD_CONTROL_STATUS,
    METHOD_CREDENTIAL_PUT,
    METHOD_EXECUTION_CANCEL,
    METHOD_EXECUTION_DESCRIBE,
    METHOD_EXECUTION_RECONCILE,
    METHOD_EXECUTION_SUBMIT,
    METHOD_SHADOW_PREPARE,
)
from app.plugin_live_v2.service import LiveBrokerService
from app.plugin_paper_v2 import PaperQuote
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import (
    build_hello_platform_bundle,
    build_paper_broker_bundle,
)
from tests.test_plugin_live_execution_v2 import (
    _audit_export_from_page,
    _build_fixture,
    _service_setup,
)


ROOT = Path(os.environ["PHASE11_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE11_BROWSER_BUNDLE_DIRECTORY"]).resolve()
ORIGIN = os.environ.get("PHASE11_BROWSER_ORIGIN", "http://127.0.0.1:18131")
MANAGEMENT_API_ORIGIN = os.environ.get(
    "PHASE11_BROWSER_MANAGEMENT_API_ORIGIN", "http://localhost:18131"
)
SESSION_TOKEN = "phase11-browser-session-token-0123456789abcdef"
CSRF_TOKEN = "phase11-browser-csrf-token-abcdef0123456789"
LIVE_NATIVE_CONTROL = (
    os.environ.get("PHASE11_BROWSER_LIVE_NATIVE_CONTROL", "0") == "1"
)
LIVE_TESTNET_EXECUTION = (
    os.environ.get("PHASE11_BROWSER_LIVE_TESTNET_EXECUTION", "0") == "1"
)
if LIVE_TESTNET_EXECUTION:
    LIVE_NATIVE_CONTROL = True
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE11_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 11 browser fixture requires a production frontend build")


class _InProcessDemoExecutionController:
    """Test-only async façade over the real Broker service and fake venue."""

    def __init__(
        self,
        service: LiveBrokerService,
        *,
        evidence: Any,
        secret: bytes,
    ) -> None:
        self.service = service
        self.evidence = evidence
        self.secret = secret
        self.session_id = "sess_" + "F" * 43
        self.sequence = 1
        self.policy_epoch = 0
        self.account_ref = ""
        self.shadow_ref = ""
        self.started = False
        self.closed = False
        self._cached_control = {
            "schemaVersion": "candlescope.live-control-status/1",
            "available": False,
            "mode": "unavailable",
            "generation": 0,
            "policyEpoch": 0,
            "updatedAt": None,
            "outstandingConfirmationCount": 0,
            "confirmationCounts": {
                "consumed": 0,
                "expired": 0,
                "issued": 0,
                "revoked": 0,
            },
            "eventSequence": 0,
            "eventSha256": None,
            "liveSubmitAvailable": True,
            "liveCancelAvailable": True,
            "liveTransferAvailable": False,
        }

    def _exchange(
        self,
        method: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        sequence = self.sequence
        self.sequence += 1
        response = self.service.handle(
            {
                "protocolVersion": LIVE_BROKER_PROTOCOL_VERSION,
                "sequence": sequence,
                "sessionId": self.session_id,
                "method": method,
                "policyEpoch": self.policy_epoch,
                "params": dict(params or {}),
            }
        )
        self.policy_epoch = response.policy_epoch
        if response.result is None:
            raise RuntimeError("test Broker response has no result")
        return response.result

    @staticmethod
    def _control_projection(value: dict[str, Any]) -> dict[str, Any]:
        fields = {
            "schemaVersion",
            "available",
            "mode",
            "generation",
            "policyEpoch",
            "updatedAt",
            "outstandingConfirmationCount",
            "confirmationCounts",
            "eventSequence",
            "eventSha256",
            "liveSubmitAvailable",
            "liveCancelAvailable",
            "liveTransferAvailable",
        }
        return {key: value[key] for key in fields}

    def _refresh_control(self) -> None:
        self._cached_control = self._control_projection(
            self._exchange(METHOD_CONTROL_STATUS)
        )

    async def start(self) -> None:
        if self.started:
            return
        self._exchange(METHOD_BOOTSTRAP)
        credential = self._exchange(
            METHOD_CREDENTIAL_PUT,
            {
                "evidence": self.evidence.to_wire(),
                "label": "explicit browser fake OKX Demo credential",
                "secretBase64": base64.b64encode(self.secret).decode(
                    "ascii"
                ),
            },
        )
        account = self._exchange(
            METHOD_ACCOUNT_DISCOVER,
            {"credentialHandle": credential["credentialHandle"]},
        )
        shadow = self._exchange(
            METHOD_SHADOW_PREPARE,
            {
                "accountRef": account["accountRef"],
                "intent": {
                    "idempotencyKey": "intent_" + "B" * 43,
                    "instrumentId": "BTC-USDT",
                    "side": "buy",
                    "orderType": "limit",
                    "quantity": "0.001",
                    "limitPrice": "42000",
                },
            },
        )
        self.account_ref = account["accountRef"]
        self.shadow_ref = shadow["shadowRef"]
        self._refresh_control()
        self.started = True

    async def stop(self) -> None:
        if self.closed:
            return
        self.service.close()
        self.closed = True

    def control_status_cached(self) -> dict[str, Any]:
        return dict(self._cached_control)

    async def control_status(self) -> dict[str, Any]:
        self._refresh_control()
        return dict(self._cached_control)

    async def set_control_mode(
        self,
        mode: str,
        *,
        reason: str,
        acknowledge_kill: bool,
    ) -> dict[str, Any]:
        result = self._exchange(
            METHOD_CONTROL_SET,
            {
                "mode": mode,
                "reason": reason,
                "acknowledgeKill": acknowledge_kill,
            },
        )
        self._cached_control = self._control_projection(result)
        return result

    async def kill_control(self, *, reason: str) -> dict[str, Any]:
        result = self._exchange(
            METHOD_CONTROL_KILL,
            {"reason": reason},
        )
        self._cached_control = self._control_projection(result)
        return result

    async def revoke_authority(
        self,
        *,
        scope_type: str,
        subject: str,
        reason: str,
    ) -> dict[str, Any]:
        result = self._exchange(
            METHOD_AUTHORITY_REVOKE,
            {
                "scopeType": scope_type,
                "subject": subject,
                "reason": reason,
            },
        )
        self._cached_control = self._control_projection(result)
        return result

    async def preview_confirmation(
        self,
        *,
        account_ref: str,
        shadow_ref: str,
    ) -> dict[str, Any]:
        return self._exchange(
            METHOD_CONFIRMATION_PREVIEW,
            {"accountRef": account_ref, "shadowRef": shadow_ref},
        )

    async def issue_confirmation(
        self,
        *,
        account_ref: str,
        shadow_ref: str,
        expected_intent_sha256: str,
        expected_policy_epoch: int,
        expected_control_generation: int,
        ttl_seconds: int,
    ) -> dict[str, Any]:
        result = self._exchange(
            METHOD_CONFIRMATION_ISSUE,
            {
                "accountRef": account_ref,
                "shadowRef": shadow_ref,
                "expectedIntentSha256": expected_intent_sha256,
                "expectedPolicyEpoch": expected_policy_epoch,
                "expectedControlGeneration": (
                    expected_control_generation
                ),
                "ttlSeconds": ttl_seconds,
            },
        )
        self._refresh_control()
        return result

    async def revoke_confirmation(
        self,
        receipt_ref: str,
        *,
        reason: str,
    ) -> dict[str, Any]:
        result = self._exchange(
            METHOD_CONFIRMATION_REVOKE,
            {"receiptRef": receipt_ref, "reason": reason},
        )
        self._refresh_control()
        return result

    async def describe_confirmation(
        self,
        receipt_ref: str,
    ) -> dict[str, Any]:
        return self._exchange(
            METHOD_CONFIRMATION_DESCRIBE,
            {"receiptRef": receipt_ref},
        )

    @staticmethod
    def _execution_params(
        *,
        account_ref: str,
        shadow_ref: str,
        receipt_ref: str,
        expected_confirmation_sha256: str,
        expected_policy_epoch: int,
        expected_control_generation: int,
    ) -> dict[str, Any]:
        return {
            "accountRef": account_ref,
            "shadowRef": shadow_ref,
            "receiptRef": receipt_ref,
            "expectedConfirmationSha256": expected_confirmation_sha256,
            "expectedPolicyEpoch": expected_policy_epoch,
            "expectedControlGeneration": expected_control_generation,
        }

    async def submit_execution(self, **values: Any) -> dict[str, Any]:
        result = self._exchange(
            METHOD_EXECUTION_SUBMIT,
            self._execution_params(**values),
        )
        self._refresh_control()
        return result

    async def cancel_execution(self, **values: Any) -> dict[str, Any]:
        result = self._exchange(
            METHOD_EXECUTION_CANCEL,
            self._execution_params(**values),
        )
        self._refresh_control()
        return result

    async def reconcile_execution(
        self,
        *,
        account_ref: str,
        shadow_ref: str,
    ) -> dict[str, Any]:
        return self._exchange(
            METHOD_EXECUTION_RECONCILE,
            {"accountRef": account_ref, "shadowRef": shadow_ref},
        )

    async def describe_execution(
        self,
        *,
        shadow_ref: str,
    ) -> dict[str, Any]:
        return self._exchange(
            METHOD_EXECUTION_DESCRIBE,
            {"shadowRef": shadow_ref},
        )

    async def export_audit(self) -> dict[str, Any]:
        page = self._exchange(
            METHOD_AUDIT_EXPORT_PAGE,
            {
                "controlAfterSequence": 0,
                "shadowAfterSequence": 0,
                "executionAfterSequence": 0,
                "controlThroughSequence": 0,
                "shadowThroughSequence": 0,
                "executionThroughSequence": 0,
                "limit": 16,
            },
        )
        return _audit_export_from_page(page)


BUNDLE_FIXTURE = build_paper_broker_bundle(BUNDLE_DIRECTORY)
PLATFORM = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
    trust_level="first-party-pinned",
    paper_trading_enabled=True,
    live_broker_foundation_enabled=LIVE_NATIVE_CONTROL,
    live_account_readonly_enabled=LIVE_NATIVE_CONTROL,
    live_reconciliation_shadow_enabled=LIVE_NATIVE_CONTROL,
    live_native_control_enabled=LIVE_NATIVE_CONTROL,
    live_testnet_execution_enabled=LIVE_TESTNET_EXECUTION,
)
BROWSER_EXECUTION_CONTROLLER: _InProcessDemoExecutionController | None = None
BROWSER_EXECUTION_MUTATION: Any | None = None
BROWSER_EXECUTION_QUERY: Any | None = None
if LIVE_TESTNET_EXECUTION:
    execution_fixture = _build_fixture(
        BUNDLE_DIRECTORY / "live-execution-release"
    )
    (
        execution_service,
        BROWSER_EXECUTION_MUTATION,
        BROWSER_EXECUTION_QUERY,
        execution_secret,
    ) = _service_setup(
        ROOT / "live-broker-v1",
        execution_fixture,
    )
    BROWSER_EXECUTION_CONTROLLER = _InProcessDemoExecutionController(
        execution_service,
        evidence=execution_fixture.evidence,
        secret=execution_secret,
    )
    PLATFORM.live_broker = BROWSER_EXECUTION_CONTROLLER  # type: ignore[assignment]
elif LIVE_NATIVE_CONTROL:
    live_bundle = build_hello_platform_bundle(
        BUNDLE_DIRECTORY / "live-authority-release"
    ).bundle
    live_identity = live_bundle.manifest.plugin
    live_release_lock = BUNDLE_DIRECTORY / "live-release-lock.json"
    live_release_lock.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "connectors": [
                    {
                        "connectorId": (
                            OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
                        ),
                        "pluginId": live_identity.id,
                        "version": live_identity.version,
                        "publisher": live_identity.publisher,
                        "bundleSha256": live_bundle.sha256,
                        "manifestSha256": live_bundle.manifest_sha256,
                    }
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    live_trust_store = LivePublisherTrustStore.from_path(live_release_lock)
    PLATFORM.live_broker = LiveBrokerController(
        enabled=True,
        root=ROOT / "live-broker-v1",
        release_lock_path=live_release_lock,
        trust_store=live_trust_store,
        vault_backend="fake",
        allow_test_backend=True,
        read_only_accounts_enabled=True,
        reconciliation_shadow_enabled=True,
        native_control_enabled=True,
    )
INSTALLATION = PLATFORM.installer.install(
    BUNDLE_FIXTURE.bundle.path,
    expected_sha256=BUNDLE_FIXTURE.bundle.sha256,
    enabled=True,
)
for permission in BUNDLE_FIXTURE.bundle.manifest.permissions.required:
    PLATFORM.installer.grant_permission(
        INSTALLATION.plugin_id,
        permission.id,
        scope=permission.scope,
    )
PLATFORM.installer.enable(INSTALLATION.plugin_id)
GUARD = LocalManagementGuard(
    (ORIGIN,),
    session_token=SESSION_TOKEN,
    csrf_token=CSRF_TOKEN,
)
CURRENT_QUOTE: PaperQuote | None = None


def _browser_exchange() -> dict[str, Any]:
    return {
        "exchange": "binance",
        "name": "Browser Fixture",
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
        "known_limitations": ["Phase 11A browser fixture only"],
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


async def _publish_fresh_quote() -> PaperQuote:
    global CURRENT_QUOTE
    now_ms = int(time.time() * 1_000)
    CURRENT_QUOTE = PaperQuote(
        f"phase11-browser-quote-{now_ms}",
        "BTCUSDT",
        "spot",
        "100",
        "100.5",
        now_ms,
    )
    await PLATFORM.publish_paper_quote(
        CURRENT_QUOTE, trace_id="phase11-browser-host-quote"
    )
    return CURRENT_QUOTE


@asynccontextmanager
async def lifespan(app: FastAPI):
    await PLATFORM.start()
    await _publish_fresh_quote()
    try:
        yield
    finally:
        await PLATFORM.stop()


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


@app.post("/api/v1/settings/cache-limits")
async def browser_cache_limits() -> dict[str, Any]:
    return {"updated": True}


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
    supervisor = next(
        (
            PLATFORM.manager.supervisor(*owner).snapshot()
            for owner in PLATFORM.manager.owner_keys()
            if owner == (INSTALLATION.plugin_id, "main")
        ),
        None,
    )
    return {
        "ready": True,
        "bundleSha256": BUNDLE_FIXTURE.bundle.sha256,
        "paper": PLATFORM.paper.status(),
        "quote": CURRENT_QUOTE.to_wire() if CURRENT_QUOTE is not None else None,
        "sidecarRequests": supervisor["requests"] if supervisor else None,
        "sidecarRestarts": supervisor["restarts"] if supervisor else None,
        "auditEvents": len(PLATFORM.audit_log.read_all()),
        "liveControl": PLATFORM.live_control_public_status(),
        "liveExecutionFixture": (
            {
                "backend": "explicit-test-fake",
                "connectorId": OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
                "accountRef": BROWSER_EXECUTION_CONTROLLER.account_ref,
                "shadowRef": BROWSER_EXECUTION_CONTROLLER.shadow_ref,
                "submitCalls": len(BROWSER_EXECUTION_MUTATION.submit_calls),
                "cancelCalls": len(BROWSER_EXECUTION_MUTATION.cancel_calls),
                "queryCalls": len(BROWSER_EXECUTION_QUERY.calls),
                "executionStatus": (
                    BROWSER_EXECUTION_CONTROLLER.service.execution_ledger.status()
                ),
            }
            if BROWSER_EXECUTION_CONTROLLER is not None
            and BROWSER_EXECUTION_MUTATION is not None
            and BROWSER_EXECUTION_QUERY is not None
            and BROWSER_EXECUTION_CONTROLLER.started
            else None
        ),
    }


@app.post("/phase11/quote/refresh")
async def refresh_quote() -> dict[str, Any]:
    return (await _publish_fresh_quote()).to_wire()


@app.get("/", response_class=HTMLResponse)
async def frontend_index() -> HTMLResponse:
    html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
    quote_json = json.dumps(
        CURRENT_QUOTE.to_wire() if CURRENT_QUOTE is not None else None,
        separators=(",", ":"),
    )
    live_fixture_json = json.dumps(
        {
            "backend": "explicit-test-fake",
            "accountRef": BROWSER_EXECUTION_CONTROLLER.account_ref,
            "shadowRef": BROWSER_EXECUTION_CONTROLLER.shadow_ref,
        }
        if BROWSER_EXECUTION_CONTROLLER is not None
        and BROWSER_EXECUTION_CONTROLLER.started
        else None,
        separators=(",", ":"),
    )
    bootstrap = f"""
<script>
localStorage.setItem("candlescope-active-indicators", JSON.stringify([{{
  id: "vol", name: "VOL", engineName: "VOL", script: "", params: {{}},
  description: "Browser fixture", category: "", paneTarget: "volume",
  isPreset: true, visible: false
}}]));
window.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__ = {{
  apiBase: "{MANAGEMENT_API_ORIGIN}/api/v2/plugins",
  sessionToken: "{SESSION_TOKEN}",
  csrfToken: "{CSRF_TOKEN}"
}};
window.__CANDLESCOPE_PHASE11_QUOTE_V1__ = {quote_json};
window.__CANDLESCOPE_PHASE11_LIVE_EXECUTION_FIXTURE_V1__ = {live_fixture_json};
</script>
"""
    return HTMLResponse(html.replace("</head>", bootstrap + "</head>"))


app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase11-frontend")
