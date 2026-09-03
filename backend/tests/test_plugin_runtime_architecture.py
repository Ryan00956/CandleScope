from __future__ import annotations

import ast
from pathlib import Path


BACKEND_ROOT = Path(__file__).parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
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


def test_phase4_indicator_router_depends_only_on_generic_host_contracts() -> None:
    routing_files = [
        BACKEND_ROOT / "app" / "indicator" / "runtime_routes.py",
        BACKEND_ROOT / "app" / "indicator" / "runtime_service.py",
    ]
    for path in routing_files:
        source = path.read_text(encoding="utf-8")
        assert "pyne_runtime" not in source
        assert "pine_compat" not in source
        assert "execute_pyne_script" not in source

    allowed_host_importers = {path.name for path in routing_files}
    production_indicator_files = [
        *BACKEND_ROOT.joinpath("app", "indicator").rglob("*.py"),
        *BACKEND_ROOT.joinpath("app", "api", "v1").glob("*indicator*.py"),
    ]
    for path in production_indicator_files:
        imports = _imported_modules(path)
        if any(module.startswith("app.plugin_runtime") for module in imports):
            assert path.name in allowed_host_importers, (
                f"transport or runtime implementation bypasses the generic "
                f"Indicator router: {path}"
            )


def test_installer_is_offline_wheel_only_and_never_mutates_backend_python() -> None:
    installer = (HOST_ROOT / "installer.py").read_text(encoding="utf-8")
    bundle = (HOST_ROOT / "bundle.py").read_text(encoding="utf-8")
    wheel_install = (
        BACKEND_ROOT / "app" / "core" / "python_wheel_install.py"
    ).read_text(encoding="utf-8")
    combined = installer + bundle + wheel_install

    for forbidden in (
        "urllib",
        "requests",
        "httpx",
        "pip wheel",
        "setup.py",
        "build_sdist",
    ):
        assert forbidden not in combined
    assert '"--no-index"' in wheel_install
    assert '"--no-deps"' in wheel_install
    assert '"--only-binary=:all:"' in wheel_install
    assert '"--isolated"' in wheel_install
    assert '"--target"' in wheel_install
    assert '"-m",\n                "venv"' in installer
    assert "runtime-registry.json" not in bundle


def test_candlescope_contains_no_pyne_runtime_snapshot_or_in_process_facade() -> None:
    assert not (REPOSITORY_ROOT / "packages" / "pyne-runtime").exists()
    assert not (BACKEND_ROOT / "app" / "indicator" / "pyne").exists()

    for root in (
        BACKEND_ROOT / "app" / "api",
        BACKEND_ROOT / "app" / "indicator",
    ):
        for path in root.rglob("*.py"):
            imports = _imported_modules(path)
            assert not any(
                module == "pyne_runtime"
                or module.startswith("pyne_runtime.")
                or module == "app.indicator.pyne"
                or module.startswith("app.indicator.pyne.")
                for module in imports
            ), f"{path} still imports an in-process Pyne runtime"
