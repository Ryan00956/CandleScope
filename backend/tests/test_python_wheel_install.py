from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.python_wheel_install import (
    InstalledDependencyError,
    installed_distribution_versions,
    venv_python,
    venv_site_packages,
    verify_installed_dependencies,
)
from app.plugin_core_v2.runtime_providers.base import (
    RuntimeInstallationRequest,
    RuntimeProviderError,
)
from app.plugin_core_v2.runtime_providers.python import PythonModuleProvider
from app.plugin_installer_v2.errors import PlatformInstallerError
from app.plugin_installer_v2.installer import PlatformPluginInstaller
from app.plugin_runtime.errors import PluginInstallerError
from app.plugin_runtime.installer import PluginInstaller


def _distribution(
    installation: Path,
    name: str,
    version: str = "1.0",
    requirements: tuple[str, ...] = (),
) -> None:
    metadata = (
        venv_site_packages(installation) / f"{name}-{version}.dist-info" / "METADATA"
    )
    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
        + "".join(f"Requires-Dist: {value}\n" for value in requirements),
        encoding="utf-8",
    )


def _no_process(*_args, **_kwargs):
    raise AssertionError("metadata verification must not execute an interpreter")


def _verify_route(route: str, installation: Path, expected: dict[str, str]) -> None:
    if route == "provider":
        executable = venv_python(installation)
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"")
        wheel = installation / "payload.whl"
        wheel.write_bytes(b"")
        PythonModuleProvider().verify_installation(
            RuntimeInstallationRequest(
                installation=installation,
                host_executable=Path(sys.executable),
                wheel_paths=(wheel,),
                distributions=tuple(expected.items()),
                runtime_ids=("python-main",),
            ),
            _no_process,
        )
    else:
        wheels = tuple(
            SimpleNamespace(package=name, version=version)
            for name, version in expected.items()
        )
        if route == "v1":
            installer = PluginInstaller(root=installation / "registry-v1")
            installer._verify_distributions(
                installation, SimpleNamespace(wheels=wheels, runtime_id="demo")
            )
        else:
            installer = PlatformPluginInstaller(root=installation / "registry-v2")
            installer._verify_distributions(
                installation,
                SimpleNamespace(
                    wheels=wheels,
                    manifest=SimpleNamespace(plugin=SimpleNamespace(id="test.demo")),
                ),
            )


@pytest.mark.parametrize("route", ["v1", "v2", "provider"])
def test_install_verifiers_accept_package_aliases_without_running_pth(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    _distribution(tmp_path, "Demo_Pkg", requirements=("SUPPORT.lib>=1",))
    _distribution(tmp_path, "support__lib")
    site = venv_site_packages(tmp_path)
    marker = tmp_path / "pth-executed"
    (site / "review.pth").write_text(
        f"import pathlib; pathlib.Path({str(marker)!r}).touch()\n", encoding="utf-8"
    )
    monkeypatch.setattr(subprocess, "run", _no_process)
    monkeypatch.setattr(subprocess, "Popen", _no_process)
    expected = {"demo.pkg": "1.0", "Support-Lib": "1.0"}
    assert installed_distribution_versions(tmp_path, expected) == expected
    _verify_route(route, tmp_path, expected)
    assert not marker.exists()


@pytest.mark.parametrize(
    "route,error_type",
    [
        ("v1", PluginInstallerError),
        ("v2", PlatformInstallerError),
        ("provider", RuntimeProviderError),
    ],
)
@pytest.mark.parametrize("dependency_version", [None, "1.5"])
def test_install_verifiers_reject_missing_or_incompatible_dependencies(
    tmp_path: Path,
    route: str,
    error_type: type[Exception],
    dependency_version: str | None,
) -> None:
    _distribution(tmp_path, "demo", requirements=("support-lib>=2,<3",))
    expected = {"demo": "1.0"}
    if dependency_version:
        _distribution(tmp_path, "support-lib", dependency_version)
        expected["support-lib"] = dependency_version
    with pytest.raises(
        error_type, match="installed dependency check failed.*support-lib"
    ):
        _verify_route(route, tmp_path, expected)


def test_inactive_environment_markers_and_unrequested_extras_are_optional(
    tmp_path: Path,
) -> None:
    _distribution(
        tmp_path,
        "demo",
        requirements=(
            'python-two-only; python_version < "3.0"',
            f'other-platform; sys_platform != "{sys.platform}"',
            'dev-tools; extra == "dev"',
            "support_lib>=1.0rc1,<2",
        ),
    )
    _distribution(tmp_path, "Support.Lib", "1.0rc2")
    verify_installed_dependencies(tmp_path)


def test_markers_use_the_virtual_environment_python_version(tmp_path: Path) -> None:
    _distribution(
        tmp_path,
        "demo",
        requirements=(
            'old-support; python_version < "3.9"',
            'new-support; python_full_version >= "3.12.0"',
        ),
    )
    (tmp_path / "venv" / "pyvenv.cfg").write_text(
        "version = 3.8.20\n", encoding="utf-8"
    )
    with pytest.raises(InstalledDependencyError, match="old-support.*not installed"):
        verify_installed_dependencies(tmp_path)
    _distribution(tmp_path, "old-support")
    verify_installed_dependencies(tmp_path)


def test_requested_transitive_extras_are_checked_and_cycles_terminate(
    tmp_path: Path,
) -> None:
    _distribution(tmp_path, "demo", requirements=("support[fast-path]",))
    _distribution(
        tmp_path,
        "support",
        requirements=('accelerator; extra == "fast_path"', "demo"),
    )
    with pytest.raises(InstalledDependencyError, match="accelerator.*not installed"):
        verify_installed_dependencies(tmp_path)
    _distribution(tmp_path, "accelerator")
    verify_installed_dependencies(tmp_path)


@pytest.mark.parametrize("requirement", ["missing>=", 'missing; invalid_marker == "x"'])
def test_invalid_requirement_metadata_is_rejected(
    tmp_path: Path, requirement: str
) -> None:
    _distribution(tmp_path, "demo", requirements=(requirement,))
    with pytest.raises(InstalledDependencyError, match="invalid Requires-Dist"):
        verify_installed_dependencies(tmp_path)


def test_dependencies_must_be_installed_in_the_plugin_venv(tmp_path: Path) -> None:
    # packaging is installed in the backend, but cannot satisfy a plugin's dependency.
    _distribution(tmp_path, "demo", requirements=("packaging",))
    with pytest.raises(InstalledDependencyError, match="packaging.*not installed"):
        verify_installed_dependencies(tmp_path)
