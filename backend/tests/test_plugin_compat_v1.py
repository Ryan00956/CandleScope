from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from candlescope_plugin_sdk import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    LanguageDescriptor,
    RuntimeDescriptor,
)

from app.indicator.runtime_routes import IndicatorRuntimeRoute, IndicatorRuntimeRoutes
from app.indicator.runtime_service import IndicatorRuntimeService
from app.plugin_compat_v1 import V1ScriptRuntimeCompatibilityBridge
from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform, DisabledCorePluginPlatform
from app.plugin_runtime import (
    ManagedRuntimeIdentity,
    RuntimeHostService,
    RuntimeProcessSpec,
    RuntimeRegistry,
)
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.management import LocalManagementGuard


class _DescriptorHost:
    def __init__(
        self,
        version: str = "1.0.0",
        *,
        runtime_id: str = "pyne.runtime",
        language_id: str = "pyne",
        runtime_name: str = "Pyne Runtime",
    ) -> None:
        self.version = version
        self.runtime_id = runtime_id
        self.language_id = language_id
        self.runtime_name = runtime_name

    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
        assert runtime_id == self.runtime_id
        language_ids = (
            ("pyne",) if self.language_id == "pyne" else ("pyne", self.language_id)
        )
        return RuntimeDescriptor(
            id=runtime_id,
            name=self.runtime_name,
            version=self.version,
            package="candlescope-plugin-pyne",
            languages=tuple(
                LanguageDescriptor(
                    id=item,
                    name="Pyne" if item == "pyne" else f"Language {item}",
                )
                for item in language_ids
            ),
            features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            required_host_features=(),
        )

    async def execute_batch(self, runtime_id: str, request: object) -> object:
        raise AssertionError("compatibility discovery must not execute scripts")


def _runtime_host(
    *,
    version: str = "1.0.0",
    runtime_id: str = "pyne.runtime",
) -> RuntimeHostService:
    spec = RuntimeProcessSpec(
        runtime_id=runtime_id,
        expected_package="candlescope-plugin-pyne",
        expected_version=version,
        executable=Path(sys.executable).resolve(),
        enabled=True,
        auto_start=False,
        managed=ManagedRuntimeIdentity(
            installation_id="a" * 64,
            activation_id="b" * 32,
            bundle_sha256="sha256:" + "c" * 64,
        ),
    )
    return RuntimeHostService(
        RuntimeRegistry((spec,)),
        host_name="CandleScope",
        host_version="0.4.0",
    )


async def _bridge(
    root: Path,
    *,
    runtime_version: str = "1.0.0",
    runtime_name: str = "Pyne Runtime",
) -> tuple[
    V1ScriptRuntimeCompatibilityBridge,
    IndicatorRuntimeService,
    RuntimeHostService,
]:
    runtime_host = _runtime_host(version=runtime_version)
    indicator = IndicatorRuntimeService(
        IndicatorRuntimeRoutes(
            (
                IndicatorRuntimeRoute(
                    language="pyne",
                    mode="sidecar",
                    runtime_id="pyne.runtime",
                ),
            )
        ),
        host=_DescriptorHost(runtime_version, runtime_name=runtime_name),
    )
    await indicator.start()
    compatibility = V1ScriptRuntimeCompatibilityBridge(
        root=root,
        indicator_source=indicator,
        runtime_host=runtime_host,
        clock=lambda: "2026-07-23T00:00:00Z",
    )
    indicator.bind_catalog_projector(compatibility.project_indicator_catalog)
    return compatibility, indicator, runtime_host


@pytest.mark.anyio
async def test_v1_catalog_round_trips_through_unified_compatibility_catalog(
    tmp_path: Path,
) -> None:
    compatibility, indicator, _runtime_host_source = await _bridge(tmp_path)
    native = indicator.compatibility_source_catalog()

    assert await indicator.public_catalog() == native
    unified = compatibility.unified_catalog()
    assert unified["v1IndicatorCatalog"] == native
    public = unified["compatibility"]
    assert public["kind"] == "script-runtime/1"
    assert public["protocol"] == "candlescope.script-runtime/1"
    assert public["renderProtocol"] == "candlescope.render/1"
    assert public["import"]["status"] == "not-imported"
    assert public["contributions"] == [
        {
            "id": "compat.v1.pyne.runtime",
            "kind": "script-runtime/1",
            "runtimeId": "pyne.runtime",
            "title": "Pyne Runtime",
            "version": "1.0.0",
            "package": "candlescope-plugin-pyne",
            "available": True,
            "protocol": "candlescope.script-runtime/1",
            "renderProtocol": "candlescope.render/1",
            "languages": [
                {
                    "id": "pyne",
                    "name": "Pyne",
                    "extensions": [],
                    "aliases": [],
                    "routeMode": "sidecar",
                    "available": True,
                }
            ],
            "features": [
                "batch-execution/1",
                "render.line-series/1",
            ],
            "routeModes": ["sidecar"],
            "release": {
                "managed": True,
                "bundleSha256": "sha256:" + "c" * 64,
            },
            "imported": False,
        }
    ]
    serialized = str(public)
    assert str(Path(sys.executable).resolve()) not in serialized
    assert "activationId" not in serialized
    assert "installationId" not in serialized

    v1_only = DisabledCorePluginPlatform()
    v1_only.bind_v1_compatibility(compatibility)
    v1_only_catalog = v1_only.catalog()
    assert v1_only_catalog["platform"]["status"] == "disabled"
    assert v1_only_catalog["plugins"] == []
    assert v1_only_catalog["compatibility"]["contributions"][0]["runtimeId"] == (
        "pyne.runtime"
    )
    assert await indicator.public_catalog() == native
    assert not compatibility.state_path.exists()


@pytest.mark.anyio
async def test_v1_sdk_identifiers_are_not_narrowed_by_the_compatibility_catalog(
    tmp_path: Path,
) -> None:
    runtime_id = "1_py.runtime"
    language_id = "1_pyne"
    runtime_host = _runtime_host(runtime_id=runtime_id)
    indicator = IndicatorRuntimeService(
        IndicatorRuntimeRoutes(
            (
                IndicatorRuntimeRoute(
                    language="pyne",
                    mode="sidecar",
                    runtime_id=runtime_id,
                ),
                IndicatorRuntimeRoute(
                    language=language_id,
                    mode="sidecar",
                    runtime_id=runtime_id,
                ),
            )
        ),
        host=_DescriptorHost(runtime_id=runtime_id, language_id=language_id),
    )
    await indicator.start()
    compatibility = V1ScriptRuntimeCompatibilityBridge(
        root=tmp_path,
        indicator_source=indicator,
        runtime_host=runtime_host,
    )
    indicator.bind_catalog_projector(compatibility.project_indicator_catalog)

    native = indicator.compatibility_source_catalog()
    assert await indicator.public_catalog() == native
    contribution = compatibility.public_catalog()["contributions"][0]
    assert contribution["id"] == "compat.v1.1_py.runtime"
    assert contribution["runtimeId"] == runtime_id
    assert {item["id"] for item in contribution["languages"]} == {
        "pyne",
        language_id,
    }


@pytest.mark.anyio
async def test_invalid_compatibility_projection_is_isolated_from_the_v1_wire(
    tmp_path: Path,
) -> None:
    compatibility, indicator, _runtime_host_source = await _bridge(
        tmp_path,
        runtime_name="x" * 129,
    )
    native = indicator.compatibility_source_catalog()

    assert await indicator.public_catalog() == native
    assert compatibility.public_catalog() == {
        "schemaVersion": "candlescope.v1-script-runtime-compatibility/1",
        "status": "invalid",
        "kind": "script-runtime/1",
        "protocol": "candlescope.script-runtime/1",
        "renderProtocol": "candlescope.render/1",
        "import": {
            "status": "invalid",
            "stateRevision": 0,
            "activeSnapshotRevision": None,
            "sourceSha256": None,
            "importedSourceSha256": None,
            "historyDepth": 0,
            "rollbackAvailable": False,
        },
        "contributions": [],
    }
    with pytest.raises(CorePluginError):
        compatibility.import_preview()


@pytest.mark.anyio
async def test_v1_registry_import_is_previewed_idempotent_and_reversible(
    tmp_path: Path,
) -> None:
    compatibility, _indicator, runtime_host = await _bridge(tmp_path)

    preview = compatibility.import_preview()
    assert preview["action"] == "import"
    assert preview["changes"] == [{"id": "compat.v1.pyne.runtime", "action": "add"}]
    imported = compatibility.apply_import(preview["previewSha256"])
    assert imported["changed"] is True
    assert imported["compatibility"]["import"]["status"] == "current"
    assert imported["compatibility"]["contributions"][0]["imported"] is True

    repeated_preview = compatibility.import_preview()
    assert repeated_preview["changes"] == []
    assert (
        compatibility.apply_import(repeated_preview["previewSha256"])["changed"]
        is False
    )

    stale_preview = compatibility.import_preview()
    runtime_host.registry = _runtime_host(version="1.0.1").registry
    with pytest.raises(CorePluginError) as stale:
        compatibility.apply_import(stale_preview["previewSha256"])
    assert stale.value.code == "PLUGIN_V1_COMPATIBILITY_PREVIEW_STALE"

    refreshed = compatibility.import_preview()
    compatibility.apply_import(refreshed["previewSha256"])
    rollback = compatibility.rollback_preview()
    assert rollback["available"] is True
    restored = compatibility.apply_rollback(rollback["previewSha256"])
    assert restored["changed"] is True
    assert restored["compatibility"]["import"]["status"] == "stale"
    assert (
        restored["compatibility"]["import"]["importedSourceSha256"]
        != (restored["compatibility"]["import"]["sourceSha256"])
    )


@pytest.mark.anyio
async def test_corrupt_state_and_disk_failure_fail_closed_without_breaking_v1_wire(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compatibility, indicator, _runtime_host_source = await _bridge(tmp_path)
    native = indicator.compatibility_source_catalog()
    compatibility.state_path.parent.mkdir(parents=True, exist_ok=True)
    compatibility.state_path.write_text('{"schemaVersion":"corrupt"}', encoding="utf-8")

    assert compatibility.public_catalog()["status"] == "invalid"
    assert await indicator.public_catalog() == native
    with pytest.raises(CorePluginError) as corrupt:
        compatibility.import_preview()
    assert corrupt.value.code == "PLUGIN_V1_COMPATIBILITY_STATE_INVALID"

    compatibility.state_path.unlink()
    preview = compatibility.import_preview()

    def fail_write(*args: object, **kwargs: object) -> None:
        raise PlatformSecurityError(
            "PLUGIN_SECURITY_WRITE_FAILED",
            "simulated disk full",
        )

    monkeypatch.setattr(
        "app.plugin_compat_v1.bridge.atomic_write_json",
        fail_write,
    )
    with pytest.raises(PlatformSecurityError) as disk_full:
        compatibility.apply_import(preview["previewSha256"])
    assert disk_full.value.code == "PLUGIN_SECURITY_WRITE_FAILED"
    assert not compatibility.state_path.exists()
    assert await indicator.public_catalog() == native


@pytest.mark.anyio
async def test_compatibility_state_symlink_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compatibility, indicator, _runtime_host_source = await _bridge(tmp_path)
    native = indicator.compatibility_source_catalog()
    original_is_symlink = Path.is_symlink

    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: (
            True if path == compatibility.state_path else original_is_symlink(path)
        ),
    )

    assert compatibility.public_catalog()["status"] == "invalid"
    assert await indicator.public_catalog() == native
    with pytest.raises(CorePluginError) as unsafe:
        compatibility.import_preview()
    assert unsafe.value.code == "PLUGIN_V1_COMPATIBILITY_STATE_INVALID"


@pytest.mark.anyio
async def test_v1_compatibility_management_api_requires_guard_and_exact_preview(
    tmp_path: Path,
) -> None:
    compatibility, _indicator, _runtime_host_source = await _bridge(
        tmp_path / "compatibility"
    )
    platform = CorePluginPlatform(
        root=tmp_path / "platform",
        host_name="CandleScope",
        host_version="0.4.0",
    )
    platform.bind_v1_compatibility(compatibility)
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase13-session-token-0123456789abcdef",
        csrf_token="phase13-csrf-token-0123456789abcdefgh",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43200))
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
    ) as client:
        denied = await client.get(
            "/api/v2/plugins/manage/compatibility/v1/import-preview"
        )
        assert denied.status_code == 403
        preview = await client.get(
            "/api/v2/plugins/manage/compatibility/v1/import-preview",
            headers=guard.trusted_headers(),
        )
        assert preview.status_code == 200
        mutation_headers = guard.trusted_headers(user_action="import-v1-registry")
        stale = await client.post(
            "/api/v2/plugins/manage/compatibility/v1/import",
            headers=mutation_headers,
            json={"previewSha256": "sha256:" + "0" * 64},
        )
        assert stale.status_code == 409
        imported = await client.post(
            "/api/v2/plugins/manage/compatibility/v1/import",
            headers=mutation_headers,
            json={"previewSha256": preview.json()["previewSha256"]},
        )
        assert imported.status_code == 200
        assert imported.json()["compatibility"]["import"]["status"] == "current"
        catalog = await client.get("/api/v2/plugins/catalog")
        assert catalog.json()["schemaVersion"] == "candlescope.plugin-catalog/2"
        assert (
            catalog.json()["compatibility"]["contributions"][0]["kind"]
            == "script-runtime/1"
        )
    audit = platform.audit_log.read_all()
    assert [(event.category, event.action, event.outcome) for event in audit] == [
        ("v1-compatibility", "registry-import", "applied")
    ]
