from __future__ import annotations

import ast
from pathlib import Path


BACKEND_ROOT = Path(__file__).parents[1]
HOST_ROOT = BACKEND_ROOT / "app" / "plugin_host"
PLATFORM_ROOT = BACKEND_ROOT / "app" / "plugin_platform"
V1_SUPERVISOR = BACKEND_ROOT / "app" / "plugin_runtime" / "supervisor.py"


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    return imported


def test_process_host_is_business_neutral_and_does_not_depend_on_compatibility_layer() -> (
    None
):
    forbidden = (
        "app.api",
        "app.data_engine",
        "app.indicator",
        "app.plugin_platform",
        "app.plugin_runtime",
        "pine_compat",
        "pyne_runtime",
    )
    for path in HOST_ROOT.glob("*.py"):
        for module in _imports(path):
            assert not module.startswith(forbidden), f"{path.name} imports {module}"


def test_platform_manager_depends_only_on_host_and_public_sdk_not_business_modules() -> (
    None
):
    forbidden = (
        "app.api",
        "app.data_engine",
        "app.indicator",
        "app.plugin_runtime",
        "pine_compat",
        "pyne_runtime",
    )
    for path in PLATFORM_ROOT.glob("*.py"):
        for module in _imports(path):
            assert not module.startswith(forbidden), f"{path.name} imports {module}"


def test_v1_runtime_supervisor_uses_shared_process_and_framing_core() -> None:
    source = V1_SUPERVISOR.read_text(encoding="utf-8")
    imports = _imports(V1_SUPERVISOR)

    assert "app.plugin_host.framing" in imports
    assert "app.plugin_host.process" in imports
    assert "create_subprocess_exec" not in source
    assert "def _plugin_environment" not in source
    assert "def _unique_json_object" not in source
    assert "json.loads" not in source


def test_host_launch_and_transport_have_no_shell_or_unbounded_reader_queue() -> None:
    process_source = (HOST_ROOT / "process.py").read_text(encoding="utf-8")
    transport_source = (HOST_ROOT / "transport.py").read_text(encoding="utf-8")
    framing_source = (HOST_ROOT / "framing.py").read_text(encoding="utf-8")
    combined = process_source + transport_source + framing_source

    assert "create_subprocess_exec" in process_source
    for forbidden in ("create_subprocess_shell", "shell=True", "os.system"):
        assert forbidden not in combined
    assert "async def _reader_loop" in transport_source
    assert "len(self._pending) >= self.max_in_flight" in transport_source
    assert "_write_lock = asyncio.Lock()" in framing_source
    assert "asyncio.Queue" not in combined


def test_phase2_does_not_wire_an_unversioned_product_route_or_default_startup() -> None:
    production_sources = [
        BACKEND_ROOT / "app" / "main.py",
        *BACKEND_ROOT.joinpath("app", "api").rglob("*.py"),
    ]
    for path in production_sources:
        assert "app.plugin_platform" not in path.read_text(encoding="utf-8")
