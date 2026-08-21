from __future__ import annotations

import ast
import json
import tomllib
from pathlib import Path

import candlescope_plugin_pyne


ROOT = Path(__file__).parents[1]
SOURCE_ROOT = ROOT / "src" / "candlescope_plugin_pyne"


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules.add(node.module)
    return modules


def test_package_metadata_pins_only_public_runtime_contracts() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = payload["project"]

    assert project["name"] == "candlescope-plugin-pyne"
    assert project["version"] == candlescope_plugin_pyne.__version__
    assert project["requires-python"] == ">=3.11,<3.14"
    assert project["dependencies"] == [
        "candlescope-plugin-sdk==0.2.0",
        "pyne-runtime==0.3.0rc2",
    ]
    assert project["scripts"]["candlescope-pyne-runtime"].endswith(":main")


def test_bridge_never_imports_candlescope_private_packages_or_vendored_engines() -> None:
    forbidden = ("app", "pine_compat", "candlescope.backend")
    violations: list[str] = []
    for path in SOURCE_ROOT.rglob("*.py"):
        for module in _imports(path):
            if module in forbidden or module.startswith(
                tuple(f"{prefix}." for prefix in forbidden)
            ):
                violations.append(f"{path.relative_to(ROOT)} imports {module}")

    assert violations == []
    assert not (SOURCE_ROOT / "pyne_runtime").exists()
    assert not (SOURCE_ROOT / "app").exists()


def test_release_lock_tracks_the_exact_external_engine_artifact() -> None:
    lock = json.loads((ROOT / "release" / "release-lock.json").read_text(encoding="utf-8"))

    assert lock["schemaVersion"] == 1
    assert lock["plugin"] == {
        "id": "candlescope.pyne",
        "package": "candlescope-plugin-pyne",
        "version": "0.2.0",
    }
    pyne = lock["wheels"]["pyne-runtime"]
    assert pyne["version"] == "0.2.0rc1"
    assert pyne["releaseUrl"].startswith(
        "https://github.com/helenananaa/pyne-runtime/releases/download/v0.2.0rc1/"
    )
    assert pyne["sha256"] == (
        "sha256:53597fd53150c7beecdfd57ecd1c4e5c5ebaa2edf2ae1006e0723ae41467e754"
    )


def test_candidate_lock_is_local_and_does_not_rewrite_the_published_lock() -> None:
    candidate = json.loads(
        (ROOT / "release" / "release-lock.candidate.json").read_text(encoding="utf-8")
    )

    assert candidate["releaseStatus"] == "local-candidate"
    assert candidate["plugin"]["version"] == "0.3.0.dev0"
    pyne = candidate["wheels"]["pyne-runtime"]
    assert pyne == {
        "version": "0.3.0rc2",
        "source": "local-candidate-build",
        "artifactFilename": "pyne_runtime-0.3.0rc2-py3-none-any.whl",
        "sourceCommit": "49a6449dd8ebe135aa62d8ea6f808814f5c022f0",
        "sha256": "sha256:f89c898c25418188344238e156bfc4cffcb07c00bd07736ceaf1d064378b2740",
    }
    assert "releaseUrl" not in pyne
