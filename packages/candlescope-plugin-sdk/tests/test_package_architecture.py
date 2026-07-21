from __future__ import annotations

import ast
import tomllib
from pathlib import Path

import candlescope_plugin_sdk


ROOT = Path(__file__).parents[1]
SOURCE_ROOT = ROOT / "src" / "candlescope_plugin_sdk"
FORBIDDEN_IMPORTS = ("app", "pyne_runtime", "pine_compat")


def test_package_metadata_is_independently_publishable_and_dependency_free() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = payload["project"]

    assert project["name"] == "candlescope-plugin-sdk"
    assert project["requires-python"] == ">=3.11"
    assert project["dependencies"] == []
    assert payload["project"]["scripts"]["candlescope-hello-runtime"].endswith(":main")


def test_sdk_source_never_imports_candlescope_or_runtime_implementations() -> None:
    violations: list[str] = []
    for path in SOURCE_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.Import):
                modules.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules.append(node.module)
            for module in modules:
                if module in FORBIDDEN_IMPORTS or module.startswith(
                    tuple(f"{prefix}." for prefix in FORBIDDEN_IMPORTS)
                ):
                    violations.append(f"{path.relative_to(ROOT)} imports {module}")

    assert violations == []


def test_public_version_matches_package_metadata() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert candlescope_plugin_sdk.__version__ == payload["project"]["version"]
