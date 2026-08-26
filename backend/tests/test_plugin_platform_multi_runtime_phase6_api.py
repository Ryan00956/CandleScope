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
    MARKETPLACE_TEST_NOW,
    SignedMarketplaceBuilder,
    build_marketplace_bundle,
)
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


def _app(platform: CorePluginPlatform, guard: LocalManagementGuard) -> FastAPI:
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    return app


def _headers(
    guard: LocalManagementGuard,
    action: str,
    *,
    bundle_sha256: str | None = None,
) -> dict[str, str]:
    headers = guard.trusted_headers(user_action=action)
    if bundle_sha256 is not None:
        headers.update(
            {
                "Content-Type": "application/vnd.candlescope.plugin+zip",
                "X-CandleScope-Bundle-SHA256": bundle_sha256,
            }
        )
    return headers


def _trust_acknowledgements(
    platform: CorePluginPlatform,
    plugin_id: str,
    target_mode: str,
) -> list[str]:
    bundle = platform._bundles[plugin_id]
    evidence = platform._trust_evidence(bundle)
    authorization = platform.trust_policy.build_authorization(
        bundle, evidence, mode=target_mode
    )
    risks = platform.trust_policy._permission_risks(bundle)
    return list(platform.trust_policy._acknowledgements(authorization, risks))


@pytest.mark.anyio
async def test_phase6_local_install_api_is_guarded_itemized_and_two_action(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    platform = CorePluginPlatform(
        root=tmp_path / "managed",
        host_name="CandleScope",
        host_version="0.4.0",
        trust_ux_enabled=True,
    )
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase6-session-token-0123456789abcdef",
        csrf_token="phase6-csrf-token-0123456789abcdefghij",
    )
    app = _app(platform, guard)
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43600))
    bundle_bytes = fixture.bundle.path.read_bytes()
    prepare_path = "/api/v2/plugins/manage/install/prepare"
    await platform.start()
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
        ) as client:
            direct = await client.post(
                "/api/v2/plugins/manage/install",
                headers=_headers(guard, "phase6-direct-install"),
            )
            assert direct.status_code == 409
            assert "prepare/review/confirm" in direct.json()["detail"]

            trusted = _headers(
                guard,
                "phase6-prepare",
                bundle_sha256=fixture.bundle.sha256,
            )
            for forged in (
                {},
                {key: value for key, value in trusted.items() if key != "Origin"},
                {
                    key: value
                    for key, value in trusted.items()
                    if key != "X-CandleScope-CSRF"
                },
                {
                    key: value
                    for key, value in trusted.items()
                    if key != "X-CandleScope-User-Action"
                },
            ):
                denied = await client.post(
                    prepare_path,
                    headers=forged,
                    content=bundle_bytes,
                )
                assert denied.status_code == 403
            assert platform.installer.list_plugins() == ()

            prepare = await client.post(
                prepare_path,
                headers=trusted,
                content=bundle_bytes,
            )
            assert prepare.status_code == 200, prepare.text
            candidate = prepare.json()
            assert candidate["preview"]["source"]["source"] == "local-file"
            assert candidate["preview"]["authorization"]["mode"] == "trusted-local"
            assert (
                candidate["preview"]["requests"]["liveAuthority"]["grantedByTrust"]
                is False
            )
            assert platform.installer.list_plugins() == ()
            assert not platform.installer.installs_directory.exists()

            incomplete = await client.post(
                "/api/v2/plugins/manage/install/review",
                headers=_headers(guard, "phase6-review-incomplete"),
                json={
                    "candidateId": candidate["candidateId"],
                    "previewSha256": candidate["previewSha256"],
                    "reason": "Every displayed trust item must be reviewed explicitly.",
                    "acknowledgements": candidate["preview"][
                        "requiredAcknowledgements"
                    ][:-1],
                },
            )
            assert incomplete.status_code == 409
            assert (
                incomplete.json()["detail"]["code"]
                == "PLUGIN_TRUST_ACKNOWLEDGEMENT_INCOMPLETE"
            )

            review_action = "phase6-review-first-action"
            review = await client.post(
                "/api/v2/plugins/manage/install/review",
                headers=_headers(guard, review_action),
                json={
                    "candidateId": candidate["candidateId"],
                    "previewSha256": candidate["previewSha256"],
                    "reason": "Every displayed trust item was reviewed explicitly.",
                    "acknowledgements": candidate["preview"][
                        "requiredAcknowledgements"
                    ],
                },
            )
            assert review.status_code == 200, review.text
            reviewed = review.json()
            assert reviewed["confirmationStep"] == 1

            same_action = await client.post(
                "/api/v2/plugins/manage/install/confirm",
                headers=_headers(guard, review_action),
                json={
                    "candidateId": candidate["candidateId"],
                    "previewSha256": candidate["previewSha256"],
                    "confirmationToken": reviewed["confirmationToken"],
                },
            )
            assert same_action.status_code == 409
            assert (
                same_action.json()["detail"]["code"]
                == "PLUGIN_TRUST_CONFIRMATION_INVALID"
            )

            confirmed = await client.post(
                "/api/v2/plugins/manage/install/confirm",
                headers=_headers(guard, "phase6-confirm-second-action"),
                json={
                    "candidateId": candidate["candidateId"],
                    "previewSha256": candidate["previewSha256"],
                    "confirmationToken": reviewed["confirmationToken"],
                },
            )
            assert confirmed.status_code == 200, confirmed.text
            installation = confirmed.json()["installation"]
            assert installation["state"] == "active"
            assert platform.installer.list_plugins()[0]["state"] == "active"
            detail = await client.get(
                f"/api/v2/plugins/manage/{installation['pluginId']}/detail",
                headers=guard.trusted_headers(),
            )
            assert detail.status_code == 200
            assert detail.json()["trust"]["mode"] == "trusted-local"
            assert detail.json()["trust"]["decisionRecorded"] is True

            reused = await client.post(
                "/api/v2/plugins/manage/install/confirm",
                headers=_headers(guard, "phase6-confirm-token-reuse"),
                json={
                    "candidateId": candidate["candidateId"],
                    "previewSha256": candidate["previewSha256"],
                    "confirmationToken": reviewed["confirmationToken"],
                },
            )
            assert reused.status_code == 409
            assert reused.json()["detail"]["code"] == (
                "PLUGIN_TRUST_CONFIRMATION_INVALID"
            )
    finally:
        await platform.stop()


@pytest.mark.anyio
async def test_signed_marketplace_artifact_cannot_enter_local_trust_flow(
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
        marketplace_now_provider=lambda: MARKETPLACE_TEST_NOW,
        trust_ux_enabled=True,
    )
    platform.marketplace.import_index(
        builder.index_bytes(), marketplace_id=MARKETPLACE_ID
    )
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase6-market-session-0123456789abcdef",
        csrf_token="phase6-market-csrf-0123456789abcdefghij",
    )
    transport = httpx.ASGITransport(
        app=_app(platform, guard), client=("127.0.0.1", 43601)
    )
    path = "/api/v2/plugins/manage/install/prepare"
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
    ) as client:
        public_context = await client.post(
            path,
            content=fixture.bundle.path.read_bytes(),
            headers={
                "Content-Type": "application/vnd.candlescope.plugin+zip",
                "X-CandleScope-Bundle-SHA256": fixture.bundle.sha256,
            },
        )
        assert public_context.status_code == 403

        denied = await client.post(
            path,
            content=fixture.bundle.path.read_bytes(),
            headers=_headers(
                guard,
                "phase6-marketplace-local-downgrade",
                bundle_sha256=fixture.bundle.sha256,
            ),
        )
        assert denied.status_code == 409
        assert denied.json()["detail"]["code"] == (
            "PLUGIN_MARKETPLACE_TRUST_DOWNGRADE_DENIED"
        )
        assert platform.installer.list_plugins() == ()


@pytest.mark.skipif(os.name != "nt", reason="Windows AppContainer trust-change gate")
@pytest.mark.anyio
async def test_trusted_local_to_sandboxed_restarts_process_generation(
    tmp_path: Path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    plugin_id = fixture.bundle.manifest.plugin.id
    platform = CorePluginPlatform(
        root=tmp_path / "managed",
        host_name="CandleScope",
        host_version="0.4.0",
        marketplace_enabled=True,
        marketplace_roots=(builder.root,),
        marketplace_now_provider=lambda: MARKETPLACE_TEST_NOW,
        trust_ux_enabled=True,
    )
    platform.marketplace.import_index(
        builder.index_bytes(), marketplace_id=MARKETPLACE_ID
    )
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase6-generation-session-0123456789abcd",
        csrf_token="phase6-generation-csrf-0123456789abcdef",
    )
    transport = httpx.ASGITransport(
        app=_app(platform, guard), client=("127.0.0.1", 43602)
    )
    await platform.start()
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
        ) as client:
            artifact = await client.post(
                f"/api/v2/plugins/manage/marketplace/{plugin_id}/0.1.0/artifact",
                headers=_headers(
                    guard,
                    "phase6-generation-artifact",
                    bundle_sha256=fixture.bundle.sha256,
                ),
                content=fixture.bundle.path.read_bytes(),
            )
            assert artifact.status_code == 200, artifact.text
            applied = await client.post(
                f"/api/v2/plugins/manage/marketplace/{plugin_id}/apply",
                headers=_headers(guard, "phase6-generation-apply"),
            )
            assert applied.status_code == 200, applied.text
            activated = await client.post(
                f"/api/v2/plugins/manage/marketplace/{plugin_id}/activate",
                headers=_headers(guard, "phase6-generation-activate"),
            )
            assert activated.status_code == 200, activated.text
            assert (
                await platform.invoke_command(
                    "candlescope.hello-command.hello",
                    {"name": "Sandboxed"},
                    user_action=True,
                    trace_id="phase6-sandboxed-invoke",
                )
            )["message"] == "Hello, Sandboxed!"

            sandboxed = platform.manager.supervisor(plugin_id, "main")
            sandboxed_snapshot = sandboxed.snapshot()
            assert sandboxed.spec.trust_level == "untrusted"
            assert sandboxed.spec.sandbox_policy is not None
            assert sandboxed_snapshot["state"] == "active"
            assert sandboxed_snapshot["generation"] >= 1
            assert sandboxed_snapshot["instanceId"] is not None

            elevate_review = await client.post(
                f"/api/v2/plugins/manage/{plugin_id}/trust/review",
                headers=_headers(guard, "phase6-elevate-review"),
                json={
                    "targetMode": "trusted-local",
                    "reason": "Run this exact signed release as reviewed local application code.",
                    "acknowledgements": _trust_acknowledgements(
                        platform, plugin_id, "trusted-local"
                    ),
                },
            )
            assert elevate_review.status_code == 200, elevate_review.text
            elevated_token = elevate_review.json()
            elevated = await client.post(
                f"/api/v2/plugins/manage/{plugin_id}/trust/confirm",
                headers=_headers(guard, "phase6-elevate-confirm"),
                json={
                    "changeId": elevated_token["changeId"],
                    "previewSha256": elevated_token["previewSha256"],
                    "confirmationToken": elevated_token["confirmationToken"],
                },
            )
            assert elevated.status_code == 200, elevated.text
            assert elevated.json()["trustChange"]["toMode"] == "trusted-local"
            assert sandboxed.state == "stopped"
            assert (
                await platform.invoke_command(
                    "candlescope.hello-command.hello",
                    {"name": "Trusted"},
                    user_action=True,
                    trace_id="phase6-trusted-invoke",
                )
            )["message"] == "Hello, Trusted!"
            trusted = platform.manager.supervisor(plugin_id, "main")
            trusted_snapshot = trusted.snapshot()
            assert trusted is not sandboxed
            assert trusted.spec.trust_level == "local-trusted"
            assert trusted.spec.sandbox_policy is None
            assert trusted_snapshot["state"] == "active"
            assert (
                trusted_snapshot["instanceId"],
                trusted_snapshot["generation"],
            ) != (
                sandboxed_snapshot["instanceId"],
                sandboxed_snapshot["generation"],
            )

            downgrade_review = await client.post(
                f"/api/v2/plugins/manage/{plugin_id}/trust/review",
                headers=_headers(guard, "phase6-downgrade-review"),
                json={
                    "targetMode": "marketplace-sandboxed",
                    "reason": "Return this exact release to the restricted Marketplace sandbox.",
                    "acknowledgements": _trust_acknowledgements(
                        platform, plugin_id, "marketplace-sandboxed"
                    ),
                },
            )
            assert downgrade_review.status_code == 200, downgrade_review.text
            downgraded_token = downgrade_review.json()
            downgraded = await client.post(
                f"/api/v2/plugins/manage/{plugin_id}/trust/confirm",
                headers=_headers(guard, "phase6-downgrade-confirm"),
                json={
                    "changeId": downgraded_token["changeId"],
                    "previewSha256": downgraded_token["previewSha256"],
                    "confirmationToken": downgraded_token["confirmationToken"],
                },
            )
            assert downgraded.status_code == 200, downgraded.text
            assert downgraded.json()["trustChange"]["toMode"] == (
                "marketplace-sandboxed"
            )
            assert trusted.state == "stopped"
            assert (
                await platform.invoke_command(
                    "candlescope.hello-command.hello",
                    {"name": "Restricted"},
                    user_action=True,
                    trace_id="phase6-restricted-invoke",
                )
            )["message"] == "Hello, Restricted!"
            restricted = platform.manager.supervisor(plugin_id, "main")
            restricted_snapshot = restricted.snapshot()
            assert restricted is not trusted
            assert restricted.spec.trust_level == "untrusted"
            assert restricted.spec.sandbox_policy is not None
            assert restricted_snapshot["state"] == "active"
            assert (
                restricted_snapshot["instanceId"],
                restricted_snapshot["generation"],
            ) != (
                trusted_snapshot["instanceId"],
                trusted_snapshot["generation"],
            )
    finally:
        await platform.stop()
