from __future__ import annotations

import ast
from pathlib import Path


BACKEND_ROOT = Path(__file__).parents[1]
HOST_ROOT = BACKEND_ROOT / "app" / "plugin_runtime"


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def test_generic_host_does_not_import_runtime_implementations_or_indicator() -> None:
    forbidden = (
        "app.indicator",
        "pyne_runtime",
        "pine_compat",
    )
    for path in HOST_ROOT.glob("*.py"):
        for module in _imported_modules(path):
            assert not module.startswith(forbidden), f"{path.name} imports {module}"


def test_supervisor_never_uses_a_shell_launch_api() -> None:
    source = (HOST_ROOT / "supervisor.py").read_text(encoding="utf-8")
    assert "create_subprocess_shell" not in source
    assert "shell=True" not in source
    assert "os.system" not in source


def test_backend_installs_the_shared_sdk_contract_from_the_monorepo() -> None:
    requirements = (
        (BACKEND_ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    )
    assert requirements[0] == "-e ../packages/candlescope-plugin-sdk"


def test_main_has_no_indicator_sidecar_cutover_in_phase_2() -> None:
    production_indicator_files = [
        *BACKEND_ROOT.joinpath("app", "indicator").rglob("*.py"),
        *BACKEND_ROOT.joinpath("app", "api", "v1").glob("*indicator*.py"),
    ]
    for path in production_indicator_files:
        source = path.read_text(encoding="utf-8")
        assert "plugin_runtime" not in source, f"unexpected Phase 2 routing in {path}"
