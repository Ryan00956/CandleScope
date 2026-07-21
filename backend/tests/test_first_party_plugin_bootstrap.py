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


OFFICIAL_SHA256 = (
    "sha256:a1812e0e2b43670e75858b5f57d59f71a403350360ea58bf2822efba7d34a216"
)


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _release(payload: bytes) -> OfficialPluginRelease:
    return OfficialPluginRelease(
        runtime_id="candlescope.pyne",
        package="candlescope-plugin-pyne",
        version="0.2.0",
        filename="candlescope-pyne-test.cspkg",
        url="https://github.com/Ryan00956/CandleScope/releases/download/test/test.cspkg",
        sha256=f"sha256:{hashlib.sha256(payload).hexdigest()}",
        size=len(payload),
        system=platform.system(),
        machine=platform.machine(),
        implementation=platform.python_implementation(),
        python_version=f"{platform.python_version_tuple()[0]}.{platform.python_version_tuple()[1]}",
    )


def _write_lock(path: Path, release: OfficialPluginRelease) -> Path:
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
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def test_checked_in_release_lock_pins_the_public_development_asset() -> None:
    releases = load_official_plugin_releases(DEFAULT_RELEASE_LOCK_PATH)

    assert len(releases) == 1
    release = releases[0]
    assert release.runtime_id == "candlescope.pyne"
    assert release.version == "0.2.0"
    assert release.sha256 == OFFICIAL_SHA256
    assert release.size == 13_006_218
    assert release.url.endswith(
        "/candlescope-plugin-pyne-v0.2.0-dev.1/"
        "candlescope-pyne-0.2.0-cp312-win_amd64.cspkg"
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
        environ={
            "LOCALAPPDATA": str(tmp_path / "local-app-data"),
            "CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE": str(bundle),
        },
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
        environ={"LOCALAPPDATA": str(tmp_path)},
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
            environ={"LOCALAPPDATA": str(tmp_path)},
            release_lock_path=lock,
            installer_factory=Installer,
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
