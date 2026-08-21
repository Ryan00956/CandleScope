from __future__ import annotations

import hashlib
import io
import json
import platform
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.first_party_plugin_bootstrap import (
    DEFAULT_RELEASE_LOCK_PATH,
    FirstPartyPluginBootstrapError,
    OfficialPluginRelease,
    download_official_plugin_bundle,
    ensure_first_party_plugins_from_environment,
    load_official_plugin_releases,
)
from app.plugin_runtime.errors import PluginBundleError
from app.plugin_runtime.registry import load_runtime_registry
from tests.plugin_runtime_bundle_testkit import build_hello_bundle


OFFICIAL_SHA256 = (
    "sha256:a1812e0e2b43670e75858b5f57d59f71a403350360ea58bf2822efba7d34a216"
)
OFFICIAL_PINE_SHA256 = (
    "sha256:f14094a6243485d198814464d359ae05711b6cbec34adb7030998caad2c1a378"
)


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _release(
    payload: bytes,
    *,
    runtime_id: str = "candlescope.pyne",
) -> OfficialPluginRelease:
    pine = runtime_id == "candlescope.pine-compat"
    return OfficialPluginRelease(
        runtime_id=runtime_id,
        package=(
            "candlescope-plugin-pine-compat" if pine else "candlescope-plugin-pyne"
        ),
        version="0.2.0",
        filename=(
            "candlescope-pine-compat-test.cspkg"
            if pine
            else "candlescope-pyne-test.cspkg"
        ),
        url="https://github.com/helenananaa/CandleScope/releases/download/test/test.cspkg",
        sha256=f"sha256:{hashlib.sha256(payload).hexdigest()}",
        size=len(payload),
        system=platform.system(),
        machine=platform.machine(),
        implementation=platform.python_implementation(),
        python_version=f"{platform.python_version_tuple()[0]}.{platform.python_version_tuple()[1]}",
    )


def _write_lock(path: Path, *releases: OfficialPluginRelease) -> Path:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "plugins": [
                    {
                        "runtimeId": release.runtime_id,
                        "package": release.package,
                        "version": release.version,
                        "filename": release.filename,
                        "url": release.url,
                        "sha256": release.sha256,
                        "size": release.size,
                        "platform": {
                            "system": release.system,
                            "machine": release.machine,
                            "implementation": release.implementation,
                            "pythonVersion": release.python_version,
                        },
                    }
                    for release in releases
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_routes(
    path: Path,
    *routes: tuple[str, str],
) -> Path:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "routes": [
                    {
                        "language": language,
                        "mode": "sidecar",
                        "runtimeId": runtime_id,
                    }
                    for language, runtime_id in routes
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _single_pyne_environment(tmp_path: Path, **values: str) -> dict[str, str]:
    routes = _write_routes(
        tmp_path / "routes.json",
        ("pyne", "candlescope.pyne"),
    )
    return {
        "LOCALAPPDATA": str(tmp_path / "local-app-data"),
        "CANDLESCOPE_INDICATOR_RUNTIME_ROUTES": str(routes),
        **values,
    }


def test_checked_in_release_lock_pins_the_public_development_asset() -> None:
    releases = load_official_plugin_releases(DEFAULT_RELEASE_LOCK_PATH)

    assert len(releases) == 2
    by_runtime = {release.runtime_id: release for release in releases}
    pyne = by_runtime["candlescope.pyne"]
    assert pyne.version == "0.2.0"
    assert pyne.sha256 == OFFICIAL_SHA256
    assert pyne.size == 13_006_218
    assert pyne.url.endswith(
        "/candlescope-plugin-pyne-v0.2.0-dev.1/"
        "candlescope-pyne-0.2.0-cp312-win_amd64.cspkg"
    )
    pine = by_runtime["candlescope.pine-compat"]
    assert pine.version == "0.2.0"
    assert pine.sha256 == OFFICIAL_PINE_SHA256
    assert pine.size == 2_997_572
    assert pine.url.endswith(
        "/candlescope-plugin-pine-compat-v0.2.0-dev.1/"
        "candlescope-pine-compat-0.2.0-cp312-win_amd64.cspkg"
    )


def test_download_verifies_before_committing_and_reuses_cache(tmp_path: Path) -> None:
    payload = b"deterministic test bundle"
    release = _release(payload)
    calls: list[Any] = []

    def opener(request: Any, *, timeout: float) -> _Response:
        calls.append((request.full_url, timeout))
        return _Response(payload)

    path, downloaded = download_official_plugin_bundle(
        release,
        tmp_path,
        timeout_seconds=7.5,
        opener=opener,
    )
    repeated, repeated_download = download_official_plugin_bundle(
        release,
        tmp_path,
        opener=lambda *_args, **_kwargs: pytest.fail("cache hit must not download"),
    )

    assert downloaded is True
    assert repeated_download is False
    assert repeated == path
    assert path.read_bytes() == payload
    assert calls == [(release.url, 7.5)]
    assert list(tmp_path.glob("*.download")) == []


def test_download_rejects_wrong_bytes_without_poisoning_cache(tmp_path: Path) -> None:
    release = _release(b"expected")

    with pytest.raises(FirstPartyPluginBootstrapError, match="pinned size"):
        download_official_plugin_bundle(
            release,
            tmp_path,
            opener=lambda *_args, **_kwargs: _Response(b"tampered!"),
        )

    assert not (tmp_path / release.filename).exists()
    assert list(tmp_path.glob("*.download")) == []


def test_ensure_installs_exact_local_override_as_required_runtime(
    tmp_path: Path,
) -> None:
    payload = b"local verified bundle"
    release = _release(payload)
    lock = _write_lock(tmp_path / "releases.json", release)
    bundle = tmp_path / release.filename
    bundle.write_bytes(payload)
    install_calls: list[dict[str, Any]] = []

    class Installer:
        def __init__(self, **kwargs: Any) -> None:
            self.registry_path = kwargs["registry_path"]

        def list_plugins(self) -> tuple[dict[str, Any], ...]:
            return ()

        def install(self, path: Path, **kwargs: Any) -> Any:
            install_calls.append({"path": path, **kwargs})
            return SimpleNamespace(
                changed=True,
                installation_path=tmp_path / "installed",
            )

    result = ensure_first_party_plugins_from_environment(
        host_name="CandleScope",
        host_version="0.3.0",
        environ=_single_pyne_environment(
            tmp_path,
            CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE=str(bundle),
        ),
        release_lock_path=lock,
        installer_factory=Installer,
    )

    assert result.status == "installed"
    assert result.changed is True
    assert result.downloaded is False
    assert install_calls == [
        {
            "path": bundle.resolve(),
            "expected_sha256": release.sha256,
            "enabled": True,
            "auto_start": True,
            "required": True,
        }
    ]


def test_ensure_checks_matching_activation_without_downloading(tmp_path: Path) -> None:
    payload = b"unused because activation already matches"
    release = _release(payload)
    lock = _write_lock(tmp_path / "releases.json", release)
    checks: list[str] = []

    class Installer:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def list_plugins(self) -> tuple[dict[str, Any], ...]:
            return (
                {
                    "runtimeId": release.runtime_id,
                    "version": release.version,
                    "bundleSha256": release.sha256,
                    "enabled": True,
                    "autoStart": True,
                    "required": True,
                    "managed": True,
                },
            )

        def check(self, runtime_id: str) -> Any:
            checks.append(runtime_id)
            return SimpleNamespace(activation_id="activation-1")

        def install(self, *_args: Any, **_kwargs: Any) -> Any:
            pytest.fail("matching activation must not install")

    result = ensure_first_party_plugins_from_environment(
        host_name="CandleScope",
        host_version="0.3.0",
        environ=_single_pyne_environment(tmp_path),
        release_lock_path=lock,
        opener=lambda *_args, **_kwargs: pytest.fail(
            "matching activation must not download"
        ),
        installer_factory=Installer,
    )

    assert result.status == "ready"
    assert result.changed is False
    assert result.reason == "checked:activation-1"
    assert checks == [release.runtime_id]


def test_ensure_never_replaces_an_unmanaged_community_activation(
    tmp_path: Path,
) -> None:
    release = _release(b"bundle")
    lock = _write_lock(tmp_path / "releases.json", release)

    class Installer:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def list_plugins(self) -> tuple[dict[str, Any], ...]:
            return ({"runtimeId": release.runtime_id, "managed": False},)

    with pytest.raises(
        FirstPartyPluginBootstrapError,
        match="refusing to replace an unmanaged runtime activation",
    ):
        ensure_first_party_plugins_from_environment(
            host_name="CandleScope",
            host_version="0.3.0",
            environ=_single_pyne_environment(tmp_path),
            release_lock_path=lock,
            installer_factory=Installer,
        )


def test_multi_runtime_bootstrap_verifies_then_installs_in_runtime_order(
    tmp_path: Path,
) -> None:
    pyne_payload = b"pyne bundle"
    pine_payload = b"pine bundle"
    pyne = _release(pyne_payload)
    pine = _release(pine_payload, runtime_id="candlescope.pine-compat")
    lock = _write_lock(tmp_path / "releases.json", pyne, pine)
    bundles = tmp_path / "bundles"
    bundles.mkdir()
    (bundles / pyne.filename).write_bytes(pyne_payload)
    (bundles / pine.filename).write_bytes(pine_payload)
    installs: list[str] = []

    class Installer:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def list_plugins(self) -> tuple[dict[str, Any], ...]:
            return ()

        def install_many(
            self,
            bundles: tuple[tuple[Path, str], ...],
            **_kwargs: Any,
        ) -> tuple[Any, ...]:
            installs.extend(path.name for path, _sha256 in bundles)
            return tuple(
                SimpleNamespace(
                    changed=True,
                    installation_path=tmp_path / "installed" / path.stem,
                )
                for path, _sha256 in bundles
            )

    result = ensure_first_party_plugins_from_environment(
        host_name="CandleScope",
        host_version="0.3.0",
        environ={
            "LOCALAPPDATA": str(tmp_path / "local-app-data"),
            "CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE": str(bundles),
        },
        release_lock_path=lock,
        installer_factory=Installer,
    )

    assert installs == [pine.filename, pyne.filename]
    assert result.status == "installed"
    assert result.changed is True
    assert result.downloaded is False
    assert [item.runtime_id for item in result.plugins] == [
        "candlescope.pine-compat",
        "candlescope.pyne",
    ]
    wire = result.to_wire()
    assert wire["count"] == 2
    assert [item["status"] for item in wire["plugins"]] == [
        "installed",
        "installed",
    ]


def test_multi_runtime_bootstrap_verifies_every_bundle_before_install(
    tmp_path: Path,
) -> None:
    pyne = _release(b"expected pyne")
    pine = _release(b"expected pine", runtime_id="candlescope.pine-compat")
    lock = _write_lock(tmp_path / "releases.json", pyne, pine)
    bundles = tmp_path / "bundles"
    bundles.mkdir()
    (bundles / pine.filename).write_bytes(b"expected pine")
    (bundles / pyne.filename).write_bytes(b"tampered")
    installs: list[str] = []

    class Installer:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def list_plugins(self) -> tuple[dict[str, Any], ...]:
            return ()

        def install(self, path: Path, **_kwargs: Any) -> Any:
            installs.append(path.name)
            pytest.fail("no install may happen before every bundle is verified")

    with pytest.raises(FirstPartyPluginBootstrapError, match="pinned size"):
        ensure_first_party_plugins_from_environment(
            host_name="CandleScope",
            host_version="0.3.0",
            environ={
                "LOCALAPPDATA": str(tmp_path / "local-app-data"),
                "CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE": str(bundles),
            },
            release_lock_path=lock,
            installer_factory=Installer,
        )

    assert installs == []


def test_multi_runtime_internal_bundle_failure_never_partially_activates(
    tmp_path: Path,
) -> None:
    pine_fixture = build_hello_bundle(
        tmp_path / "pine-source",
        version="0.2.0",
        runtime_id="candlescope.pine-compat",
    )
    pine_payload = pine_fixture.bundle.path.read_bytes()
    pyne_payload = b"outer-digest-valid but not a plugin bundle"
    pine = _release(pine_payload, runtime_id="candlescope.pine-compat")
    pyne = _release(pyne_payload)
    lock = _write_lock(tmp_path / "releases.json", pine, pyne)
    bundles = tmp_path / "bundles"
    bundles.mkdir()
    (bundles / pine.filename).write_bytes(pine_payload)
    (bundles / pyne.filename).write_bytes(pyne_payload)
    registry = tmp_path / "plugins" / "runtime-registry.json"

    with pytest.raises(PluginBundleError):
        ensure_first_party_plugins_from_environment(
            host_name="CandleScope",
            host_version="0.3.0",
            environ={
                "LOCALAPPDATA": str(tmp_path / "local-app-data"),
                "CANDLESCOPE_RUNTIME_REGISTRY": str(registry),
                "CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE": str(bundles),
            },
            release_lock_path=lock,
        )

    assert load_runtime_registry(registry, allow_missing=True).plugins == ()


def test_default_routes_fail_closed_when_a_first_party_release_is_missing(
    tmp_path: Path,
) -> None:
    pyne = _release(b"pyne")
    lock = _write_lock(tmp_path / "releases.json", pyne)

    with pytest.raises(
        FirstPartyPluginBootstrapError,
        match="missing routed first-party runtimes: candlescope.pine-compat",
    ):
        ensure_first_party_plugins_from_environment(
            host_name="CandleScope",
            host_version="0.3.0",
            environ={"LOCALAPPDATA": str(tmp_path / "local-app-data")},
            release_lock_path=lock,
        )


def test_bootstrap_can_be_disabled_without_reading_release_state(
    tmp_path: Path,
) -> None:
    result = ensure_first_party_plugins_from_environment(
        host_name="CandleScope",
        host_version="0.3.0",
        environ={
            "LOCALAPPDATA": str(tmp_path),
            "CANDLESCOPE_OFFICIAL_PLUGIN_BOOTSTRAP": "0",
        },
        release_lock_path=tmp_path / "missing.json",
    )

    assert result.to_wire() == {
        "status": "skipped",
        "changed": False,
        "downloaded": False,
        "reason": "official-bootstrap-disabled",
    }
