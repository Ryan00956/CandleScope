"""Install and verify Python plugin wheels without executing the venv."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from email import policy
from email.parser import Parser
from pathlib import Path

from packaging.markers import default_environment
from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version


class InstalledDependencyError(ValueError):
    """Installed wheel metadata describes an unsatisfied dependency."""


@dataclass(frozen=True)
class _InstalledDistribution:
    name: str
    version: str
    requirements: tuple[str, ...]


def venv_python(installation: Path) -> Path:
    return (
        installation / "venv" / "Scripts" / "python.exe"
        if os.name == "nt"
        else installation / "venv" / "bin" / "python"
    )


def venv_site_packages(installation: Path) -> Path:
    venv = installation / "venv"
    if os.name == "nt":
        return venv / "Lib" / "site-packages"
    lib = venv / "lib"
    matches = sorted(
        path
        for path in lib.glob("python*/site-packages")
        if path.is_dir() and not path.is_symlink()
    )
    if matches:
        return matches[0]
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    return lib / version / "site-packages"


def host_wheel_install_command(
    host_executable: Path,
    site_packages: Path,
    wheel_paths: Sequence[Path],
) -> tuple[str, ...]:
    """Install wheels with the host interpreter into the venv site-packages.

    The venv interpreter is not started, so candidate ``.pth`` import lines
    cannot run during installation.
    """

    return (
        str(host_executable),
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-index",
        "--no-deps",
        "--only-binary=:all:",
        "--target",
        str(site_packages),
        *(str(path) for path in wheel_paths),
    )


def _installed_distributions(
    installation: Path,
) -> dict[str, _InstalledDistribution]:
    site_packages = venv_site_packages(installation)
    found: dict[str, _InstalledDistribution] = {}
    if site_packages.is_dir() and not site_packages.is_symlink():
        for dist_info in sorted(site_packages.glob("*.dist-info")):
            if not dist_info.is_dir() or dist_info.is_symlink():
                continue
            metadata_path = dist_info / "METADATA"
            if not metadata_path.is_file() or metadata_path.is_symlink():
                continue
            try:
                with metadata_path.open(encoding="utf-8") as handle:
                    message = Parser(policy=policy.default).parse(handle)
            except OSError:
                continue
            name = message.get("Name")
            version = message.get("Version")
            if not isinstance(name, str) or not isinstance(version, str):
                continue
            name, version = name.strip(), version.strip()
            if name and version:
                found[canonicalize_name(name)] = _InstalledDistribution(
                    name, version, tuple(message.get_all("Requires-Dist", []))
                )
    return found


def installed_distribution_versions(
    installation: Path,
    expected: Mapping[str, str],
) -> dict[str, str]:
    """Resolve Python package aliases while preserving the declared names."""
    found = _installed_distributions(installation)
    return {
        name: found[canonicalize_name(name)].version
        for name in expected
        if canonicalize_name(name) in found
    }


def _dependency_environment(installation: Path) -> dict[str, str]:
    environment = default_environment()
    # An explicitly selected host Python can differ from the backend Python.
    # venv records its version here, so checking markers needs no interpreter.
    config = installation / "venv" / "pyvenv.cfg"
    if config.is_file() and not config.is_symlink():
        for line in config.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "version":
                version = Version(value.strip())
                environment["python_full_version"] = str(version)
                environment["python_version"] = ".".join(
                    str(part) for part in version.release[:2]
                )
                if environment["implementation_name"] == "cpython":
                    environment["implementation_version"] = str(version)
                break
    return environment


def verify_installed_dependencies(installation: Path) -> None:
    """Check installed Requires-Dist without imports or .pth processing.

    Optional extras are checked only when another installed distribution
    explicitly requires them. All installed distributions' base dependencies
    are checked, matching the previous dependency-check scope.
    """
    found = _installed_distributions(installation)
    try:
        environment = _dependency_environment(installation)
    except (OSError, ValueError) as exc:
        raise InstalledDependencyError(
            "unable to read virtual environment version"
        ) from exc
    pending = [(name, "") for name in found]
    checked: set[tuple[str, str]] = set()
    while pending:
        name, extra = pending.pop()
        if (name, extra) in checked:
            continue
        checked.add((name, extra))
        distribution = found[name]
        for raw in distribution.requirements:
            try:
                requirement = Requirement(raw)
                if requirement.marker and not requirement.marker.evaluate(
                    {**environment, "extra": extra}
                ):
                    continue
            except (InvalidRequirement, ValueError) as exc:
                raise InstalledDependencyError(
                    f"{distribution.name} has invalid Requires-Dist: {raw}"
                ) from exc
            dependency_name = canonicalize_name(requirement.name)
            dependency = found.get(dependency_name)
            if dependency is None:
                raise InstalledDependencyError(
                    f"{distribution.name} requires {requirement}, which is not installed"
                )
            try:
                satisfies = requirement.specifier.contains(
                    dependency.version, prereleases=True
                )
            except InvalidVersion as exc:
                raise InstalledDependencyError(
                    f"{dependency.name} has invalid version {dependency.version}"
                ) from exc
            if not satisfies:
                raise InstalledDependencyError(
                    f"{distribution.name} requires {requirement}, "
                    f"but {dependency.name} {dependency.version} is installed"
                )
            pending.extend((dependency_name, item) for item in requirement.extras)
