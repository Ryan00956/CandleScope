from __future__ import annotations

import copy
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from candlescope_plugin_sdk.platform_v2 import PluginManifest
from candlescope_plugin_sdk.platform_v2.examples.sandbox_view import (
    sandbox_view_manifest,
)

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.assets import (
    SANDBOX_ATTRIBUTE,
    SANDBOX_CSP_PROFILE,
    sandbox_content_security_policy,
)
from app.plugin_core_v2.contracts import core_contributions
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_installer_v2 import PlatformPluginInstaller
from tests.plugin_platform_bundle_testkit import build_sandbox_view_bundle


def test_sandbox_view_contract_exactly_matches_frontend_surface() -> None:
    manifest = sandbox_view_manifest()
    contributions = core_contributions(manifest)
    assert len(contributions) == 1
    assert contributions[0].configuration == {
        "slot": "sidePanel",
        "renderer": "sandbox",
        "surface": "main-view",
    }

    missing_frontend = manifest.to_wire()
    missing_frontend.pop("frontend")
    with pytest.raises(CorePluginError, match="exactly match"):
        core_contributions(PluginManifest.from_wire(missing_frontend))

    mismatched_surface = copy.deepcopy(manifest.to_wire())
    mismatched_surface["contributions"][0]["configuration"]["surface"] = "other-view"
    with pytest.raises(CorePluginError, match="does not match"):
        core_contributions(PluginManifest.from_wire(mismatched_surface))

    mismatched_slot = copy.deepcopy(manifest.to_wire())
    mismatched_slot["contributions"][0]["configuration"]["slot"] = "bottomPanel"
    with pytest.raises(CorePluginError, match="does not match"):
        core_contributions(PluginManifest.from_wire(mismatched_slot))

    duplicate_surface = copy.deepcopy(manifest.to_wire())
    duplicate_surface["contributions"].append(
        {
            **copy.deepcopy(duplicate_surface["contributions"][0]),
            "id": "other-view",
            "title": "Other sandbox view",
        }
    )
    with pytest.raises(CorePluginError, match="exactly match"):
        core_contributions(PluginManifest.from_wire(duplicate_surface))

    executable_extra = copy.deepcopy(manifest.to_wire())
    executable_extra["contributions"][0]["configuration"]["componentUrl"] = (
        "https://untrusted.invalid/plugin.js"
    )
    with pytest.raises(CorePluginError, match="invalid shape"):
        core_contributions(PluginManifest.from_wire(executable_extra))
    with pytest.raises(ValueError, match="unsafe"):
        sandbox_content_security_policy(
            "http://127.0.0.1/api/v2/plugins/assets/acme.plugin/digest/; connect-src *"
        )


@pytest.mark.anyio
async def test_digest_asset_gateway_is_public_bounded_and_fail_closed(
    tmp_path: Path,
) -> None:
    fixture = build_sandbox_view_bundle(tmp_path / "bundle")
    assert {
        item.path for item in fixture.bundle.envelope.contents if item.kind == "web"
    } == {"web/app.js", "web/index.html", "web/styles.css"}
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "active"
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    await platform.start()
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43208))
    try:
        plugin = platform.catalog()["plugins"][0]
        assert plugin["id"] == "candlescope.sandbox-view"
        assert plugin["runtime"]["entrypoints"] == [
            {"entrypointId": "main", "state": "stopped", "generation": 0}
        ]
        contribution = plugin["contributions"][0]
        assert contribution["configuration"] == {
            "slot": "sidePanel",
            "renderer": "sandbox",
            "surface": "main-view",
            "asset": {
                "bundleDigest": fixture.bundle.sha256,
                "entry": "index.html",
                "protocol": "candlescope.ui-bridge/1",
                "sandbox": SANDBOX_ATTRIBUTE,
                "cspProfile": SANDBOX_CSP_PROFILE,
            },
        }
        assert platform.ui_snapshot()["views"] == []
        digest = fixture.bundle.sha256.removeprefix("sha256:")
        base = f"/api/v2/plugins/assets/{installed.plugin_id}/{digest}"

        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as client:
            html = await client.get(f"{base}/index.html")
            assert html.status_code == 200
            assert "Sandbox isolation lab" in html.text
            asset_base_url = (
                f"http://127.0.0.1/api/v2/plugins/assets/"
                f"{installed.plugin_id}/{digest}/"
            )
            assert html.headers["content-security-policy"] == (
                sandbox_content_security_policy(asset_base_url)
            )
            assert html.headers["cache-control"] == (
                "public, max-age=31536000, immutable"
            )
            assert html.headers["cross-origin-resource-policy"] == "cross-origin"
            assert html.headers["referrer-policy"] == "no-referrer"
            assert html.headers["x-dns-prefetch-control"] == "off"
            assert html.headers["x-content-type-options"] == "nosniff"
            assert "allow-same-origin" not in html.headers["content-security-policy"]
            assert "script-src 'self'" not in html.headers["content-security-policy"]
            assert (
                f"script-src {asset_base_url}"
                in html.headers["content-security-policy"]
            )
            assert "connect-src 'none'" in html.headers["content-security-policy"]
            assert "worker-src 'none'" in html.headers["content-security-policy"]
            assert "x-frame-options" not in html.headers

            not_modified = await client.get(
                f"{base}/index.html", headers={"If-None-Match": html.headers["etag"]}
            )
            assert not_modified.status_code == 304
            assert not not_modified.content

            assert (await client.get(f"{base}/styles.css")).status_code == 200
            assert (await client.get(f"{base}/app.js")).status_code == 200
            assert (await client.get(f"{base}/other.html")).status_code == 404
            traversal = await client.get(
                f"{base}/../manifest.json", follow_redirects=True
            )
            assert traversal.status_code == 404
            with pytest.raises(CorePluginError, match="unavailable"):
                platform.sandbox_asset(installed.plugin_id, digest, "../manifest.json")
            assert (
                await client.get(
                    f"/api/v2/plugins/assets/{installed.plugin_id}/{'0' * 64}/index.html"
                )
            ).status_code == 404

            installation = platform._installations[installed.plugin_id]
            script_path = installation / "content" / "web" / "app.js"
            original_script = script_path.read_bytes()
            script_path.write_bytes(b"tampered")
            tampered = await client.get(f"{base}/app.js")
            assert tampered.status_code == 409
            assert tampered.json() == {"detail": "plugin asset unavailable"}
            script_path.write_bytes(original_script)

            installer.disable(installed.plugin_id)
            await platform.reconcile_plugin(installed.plugin_id)
            disabled = await client.get(f"{base}/index.html")
            assert disabled.status_code == 404
            assert disabled.json() == {"detail": "plugin asset unavailable"}
    finally:
        await platform.stop()
