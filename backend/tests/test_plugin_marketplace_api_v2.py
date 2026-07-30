from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_marketplace_testkit import (
    MARKETPLACE_ID,
    SignedMarketplaceBuilder,
    build_marketplace_bundle,
)


pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(
        os.name != "nt",
        reason="verified publisher execution requires the Windows AppContainer gate",
    ),
]


async def test_signed_marketplace_api_requires_manual_staging_and_runs_untrusted(
    tmp_path: Path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    platform = CorePluginPlatform(
        root=tmp_path / "managed",
        host_name="CandleScope",
        host_version="0.4.0",
        marketplace_enabled=True,
        marketplace_roots=(builder.root,),
    )
    await platform.start()
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase12-session-token-0123456789abcdef",
        csrf_token="phase12-csrf-token-0123456789abcdefghi",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43212))

    def headers(action: str, *, content_type: str | None = None) -> dict[str, str]:
        value = guard.trusted_headers(user_action=action)
        if content_type is not None:
            value["Content-Type"] = content_type
        return value

    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
        ) as client:
            index = await client.post(
                f"/api/v2/plugins/manage/marketplace/{MARKETPLACE_ID}/index",
                content=builder.index_bytes(),
                headers=headers(
                    "phase12-import-index",
                    content_type="application/json",
                ),
            )
            assert index.status_code == 200, index.text

            public_catalog = await client.get("/api/v2/plugins/marketplace/catalog")
            assert public_catalog.status_code == 200
            release = public_catalog.json()["plugins"][0]["latest"]
            assert release["artifact"]["sha256"] == fixture.bundle.sha256
            assert release["publisherKeyId"].startswith("ed25519:")
            assert release["revoked"] is False

            artifact = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/"
                    f"{fixture.bundle.manifest.plugin.version}/artifact"
                ),
                content=fixture.bundle.path.read_bytes(),
                headers={
                    **headers(
                        "phase12-import-artifact",
                        content_type="application/vnd.candlescope.plugin+zip",
                    ),
                    "X-CandleScope-Bundle-SHA256": fixture.bundle.sha256,
                },
            )
            assert artifact.status_code == 200, artifact.text
            assert artifact.json()["candidate"]["phase"] == "verified-staged"
            assert platform.installer.list_plugins() == ()

            applied = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/apply"
                ),
                headers=headers("phase12-apply"),
            )
            assert applied.status_code == 200, applied.text
            assert applied.json()["candidate"]["phase"] == "activation-staged"
            assert platform.installer.list_plugins()[0]["state"] == "staged"
            installation_path = Path(applied.json()["installation"]["installationPath"])

            original_reconcile = platform.reconcile_plugin
            reconcile_attempts = 0

            async def fail_activation_reconcile_once(plugin_id: str):
                nonlocal reconcile_attempts
                reconcile_attempts += 1
                if reconcile_attempts == 1:
                    raise RuntimeError("injected activation reconciliation failure")
                return await original_reconcile(plugin_id)

            platform.reconcile_plugin = fail_activation_reconcile_once
            failed_reconcile = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/activate"
                ),
                headers=headers("phase12-activate-reconcile-failure"),
            )
            platform.reconcile_plugin = original_reconcile
            assert failed_reconcile.status_code == 409
            assert (
                failed_reconcile.json()["detail"]["code"]
                == "PLUGIN_MARKETPLACE_HEALTH_ROLLBACK"
            )
            assert platform.installer.list_plugins() == ()
            assert installation_path.is_dir()
            assert platform.marketplace.status()["candidates"][0]["phase"] == (
                "rolled-back"
            )

            reapplied_after_reconcile = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/apply"
                ),
                headers=headers("phase12-reapply-after-reconcile-failure"),
            )
            assert reapplied_after_reconcile.status_code == 200
            assert (
                reapplied_after_reconcile.json()["candidate"]["phase"]
                == "activation-staged"
            )

            original_health_observer = platform.observe_plugin_health

            async def fail_health_observation(_plugin_id: str):
                raise RuntimeError("injected health failure")

            platform.observe_plugin_health = fail_health_observation
            failed_activation = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/activate"
                ),
                headers=headers("phase12-activate-failure"),
            )
            assert failed_activation.status_code == 409
            assert (
                failed_activation.json()["detail"]["code"]
                == "PLUGIN_MARKETPLACE_HEALTH_ROLLBACK"
            )
            assert platform.installer.list_plugins() == ()
            assert installation_path.is_dir()
            assert platform.marketplace.status()["candidates"][0]["phase"] == (
                "rolled-back"
            )
            platform.observe_plugin_health = original_health_observer

            reapplied = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/apply"
                ),
                headers=headers("phase12-reapply"),
            )
            assert reapplied.status_code == 200, reapplied.text
            assert reapplied.json()["candidate"]["phase"] == "activation-staged"

            activated = await client.post(
                (
                    "/api/v2/plugins/manage/marketplace/"
                    f"{fixture.bundle.manifest.plugin.id}/activate"
                ),
                headers=headers("phase12-activate"),
            )
            assert activated.status_code == 200, activated.text
            assert activated.json()["observation"]["phase"] == "active"
            assert activated.json()["observation"]["observation"]["status"] == "passed"
            assert activated.json()["health"][0]["health"]["status"] == "ready"

            installed_catalog = (await client.get("/api/v2/plugins/catalog")).json()[
                "plugins"
            ][0]
            assert installed_catalog["trustLevel"] == "verified-publisher"
            assert installed_catalog["state"] == "active"
            supervisor = platform.manager.supervisor(
                fixture.bundle.manifest.plugin.id,
                "main",
            )
            assert supervisor.spec.trust_level == "untrusted"
            assert supervisor.spec.sandbox_policy is not None
            invoked = await platform.invoke_command(
                "candlescope.hello-command.hello",
                {"name": "Phase 12"},
                user_action=True,
                trace_id="phase12-runtime-invoke",
            )
            assert invoked["message"] == "Hello, Phase 12!"

            status = await client.get(
                "/api/v2/plugins/manage/marketplace/status",
                headers=guard.trusted_headers(),
            )
            assert status.status_code == 200
            assert status.json()["automaticUpdates"] is False
            assert status.json()["candidates"][0]["phase"] == "active"
    finally:
        await platform.stop()
