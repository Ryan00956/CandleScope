from __future__ import annotations

import time
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.bootstrap import build_core_plugin_platform_from_environment
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_paper_v2 import PaperQuote
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_paper_broker_bundle


def _intent(key: str, quote: PaperQuote) -> dict:
    return {
        "brokerId": "fixture-paper",
        "accountId": "paper-main",
        "clientOrderId": "client-" + key,
        "idempotencyKey": key,
        "symbol": "BTCUSDT",
        "marketType": "spot",
        "side": "buy",
        "orderType": "market",
        "quantity": "0.1",
        "limitPrice": None,
        "quoteId": quote.quote_id,
        "observedMarketTimeMs": quote.observed_market_time_ms,
    }


def test_paper_policy_requires_pinned_first_party_platform(tmp_path: Path) -> None:
    with pytest.raises(CorePluginError, match="pinned first-party"):
        CorePluginPlatform(
            root=tmp_path / "local",
            host_name="CandleScope",
            host_version="0.4.0",
            trust_level="local-trusted",
            paper_trading_enabled=True,
        )
    platform = CorePluginPlatform(
        root=tmp_path / "pinned",
        host_name="CandleScope",
        host_version="0.4.0",
        trust_level="first-party-pinned",
        paper_trading_enabled=True,
    )
    assert platform.paper_trading_enabled is True
    bootstrapped = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="0.4.0",
        environ={
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "environment"),
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "first-party-pinned",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_PAPER_TRADING_ENABLED": "1",
        },
    )
    assert isinstance(bootstrapped, CorePluginPlatform)
    assert bootstrapped.paper_trading_enabled is True


@pytest.mark.anyio
async def test_real_paper_bundle_runs_guarded_host_owned_order_flow(
    tmp_path: Path,
) -> None:
    fixture = build_paper_broker_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        trust_level="first-party-pinned",
        paper_trading_enabled=True,
    )
    installed = platform.installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "staged"
    for permission in fixture.bundle.manifest.permissions.required:
        platform.installer.grant_permission(
            installed.plugin_id,
            permission.id,
            scope=permission.scope,
        )
    assert platform.installer.enable(installed.plugin_id).state == "active"
    await platform.start()
    now_ms = int(time.time() * 1_000)
    quote = PaperQuote("host-quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms)
    await platform.publish_paper_quote(quote, trace_id="host-market-data")

    guard = LocalManagementGuard(
        ("http://127.0.0.1",),
        session_token="phase11-session-token-0123456789abcdef",
        csrf_token="phase11-csrf-token-0123456789abcdefghi",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43200))
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as client:
            assert (
                await client.get("/api/v2/plugins/manage/paper/status")
            ).status_code == 403
            status = await client.get(
                "/api/v2/plugins/manage/paper/status",
                headers=guard.trusted_headers(),
            )
            assert status.status_code == 200
            assert status.json()["mode"] == "paper-only"
            assert status.json()["liveTradingAvailable"] is False
            assert status.json()["secretsAvailable"] is False
            assert status.json()["brokers"][0]["brokerId"] == "fixture-paper"

            detail = await client.get(
                f"/api/v2/plugins/manage/{installed.plugin_id}/detail",
                headers=guard.trusted_headers(),
            )
            assert detail.status_code == 200
            assert detail.json()["paperTrading"]["available"] is True
            assert {
                item["kind"] for item in detail.json()["plugin"]["contributions"]
            } == {
                "account-provider/1",
                "order-executor/1",
            }

            submitted = await client.post(
                "/api/v2/plugins/manage/paper/orders/submit",
                headers=guard.trusted_headers(user_action="paper-submit"),
                json={"intent": _intent("api-submit-1", quote)},
            )
            assert submitted.status_code == 200
            assert submitted.json()["order"]["status"] == "filled"
            assert submitted.json()["order"]["averageFillPrice"] == "100.5"
            repeated = await client.post(
                "/api/v2/plugins/manage/paper/orders/submit",
                headers=guard.trusted_headers(user_action="paper-submit-repeat"),
                json={"intent": _intent("api-submit-1", quote)},
            )
            assert repeated.status_code == 200
            assert repeated.json()["idempotentReplay"] is True

            invalid_cancel_recovery = await client.post(
                "/api/v2/plugins/manage/paper/orders/recover",
                headers=guard.trusted_headers(user_action="paper-recover-invalid"),
                json={
                    "brokerId": "fixture-paper",
                    "accountId": "paper-main",
                    "idempotencyKey": "api-cancel-recover-invalid",
                    "targetOperation": "orders.cancel",
                },
            )
            assert invalid_cancel_recovery.status_code == 400
            missing_cancel_recovery = await client.post(
                "/api/v2/plugins/manage/paper/orders/recover",
                headers=guard.trusted_headers(user_action="paper-recover-cancel"),
                json={
                    "brokerId": "fixture-paper",
                    "accountId": "paper-main",
                    "idempotencyKey": "api-cancel-recover-missing",
                    "targetOperation": "orders.cancel",
                    "orderId": submitted.json()["order"]["orderId"],
                },
            )
            assert missing_cancel_recovery.status_code == 409
            assert missing_cancel_recovery.json()["detail"]["code"] == (
                "PLUGIN_PAPER_CANCEL_RECOVERY_NOT_FOUND"
            )

            account = await client.get(
                "/api/v2/plugins/manage/paper/accounts/fixture-paper/paper-main",
                headers=guard.trusted_headers(),
            )
            assert account.status_code == 200
            balances = {item["asset"]: item for item in account.json()["balances"]}
            assert balances["BTC"]["available"] == "2.1"

            killed = await client.post(
                "/api/v2/plugins/manage/paper/kill-switch",
                headers=guard.trusted_headers(user_action="paper-stop"),
                json={"enabled": True},
            )
            assert killed.status_code == 200
            assert killed.json()["killSwitchEnabled"] is True
            blocked = await client.post(
                "/api/v2/plugins/manage/paper/orders/submit",
                headers=guard.trusted_headers(user_action="paper-blocked"),
                json={"intent": _intent("api-submit-2", quote)},
            )
            assert blocked.status_code == 409
            assert blocked.json()["detail"]["code"] == "PLUGIN_PAPER_KILL_SWITCH"

            resumed = await client.post(
                "/api/v2/plugins/manage/paper/kill-switch",
                headers=guard.trusted_headers(user_action="paper-resume"),
                json={"enabled": False},
            )
            assert resumed.status_code == 200
            revoked = platform.installer.revoke_permission(
                installed.plugin_id, "trade.simulate"
            )
            assert revoked.activation_state == "staged"
            await platform.reconcile_plugin(installed.plugin_id)
            denied_after_revoke = await client.post(
                "/api/v2/plugins/manage/paper/orders/submit",
                headers=guard.trusted_headers(user_action="paper-revoked"),
                json={"intent": _intent("api-submit-3", quote)},
            )
            assert denied_after_revoke.status_code == 409
            assert denied_after_revoke.json()["detail"]["code"] == (
                "PLUGIN_PAPER_BROKER_UNAVAILABLE"
            )
    finally:
        await platform.stop()
