from __future__ import annotations

import ast
import json
import tomllib
from pathlib import Path

import candlescope_plugin_pine_compat


ROOT = Path(__file__).parents[1]
SOURCE_ROOT = ROOT / "src" / "candlescope_plugin_pine_compat"


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
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert project["name"] == "candlescope-plugin-pine-compat"
    assert project["version"] == candlescope_plugin_pine_compat.__version__
    assert project["dependencies"] == [
        "candlescope-plugin-sdk==0.2.0",
        "pine-compat-runtime==0.2.0",
    ]


def test_bridge_never_imports_candlescope_private_packages_or_vendored_engine() -> None:
    violations: list[str] = []
    for path in SOURCE_ROOT.rglob("*.py"):
        for module in _imports(path):
            if module == "app" or module.startswith("app."):
                violations.append(f"{path.relative_to(ROOT)} imports {module}")

    assert violations == []
    assert not (SOURCE_ROOT / "pine_compat").exists()
    assert not (ROOT / "packages" / "pine-compat-runtime").exists()


def test_release_lock_tracks_the_exact_public_engine_asset() -> None:
    lock = json.loads((ROOT / "release" / "release-lock.json").read_text(encoding="utf-8"))
    engine = lock["wheels"]["pine-compat-runtime"]

    assert lock["plugin"] == {
        "id": "candlescope.pine-compat",
        "package": "candlescope-plugin-pine-compat",
        "version": "0.2.0",
    }
    assert engine["releaseTag"] == "v0.2.0"
    assert engine["releaseCommit"] == "cec39d807a469ebae199f30bc67a91d7081a3b9f"
    assert engine["manifestSha256"] == (
        "sha256:3fce2cf4aa78ea54b3be805c5417466d9014445c50004317932d044b00f23deb"
    )
    assert engine["releaseUrl"].startswith(
        "https://github.com/Ryan00956/pine-compat-runtime/releases/download/v0.2.0/"
    )
    assert engine["sha256"] == (
        "sha256:4f38c25a92261a8594d346c858c43f2a675afaac789bb1f75458c8a568c43c3e"
    )
    assert engine["size"] == 2_961_677
