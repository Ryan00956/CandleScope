from __future__ import annotations

import ast
from pathlib import Path


BACKEND_ROOT = Path(__file__).parents[1]
REPLAY_ROOT = BACKEND_ROOT / "app" / "replay"

FORBIDDEN_MODULE_PREFIXES = (
    "app.data_engine.data_manager",
    "app.indicator.data_manager_bridge",
)
FORBIDDEN_MODULE_PARTS = {
    "api_key",
    "api_keys",
    "credentials",
    "private_api",
    "private_trading",
    "signing",
    "trading_client",
}
FORBIDDEN_SYMBOLS = {"DataManager", "EventBus", "SignedOrderClient", "TradingClient"}
DOMAIN_FORBIDDEN_MODULES = {"fastapi", "sqlite3", "starlette", "websockets"}


def _imports(path: Path) -> list[tuple[str, str | None, int]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imports: list[tuple[str, str | None, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend((alias.name, None, node.lineno) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            imports.extend((module, alias.name, node.lineno) for alias in node.names)
    return imports


def _forbidden_replay_imports(root: Path) -> list[str]:
    violations: list[str] = []
    for path in sorted(root.rglob("*.py")):
        for module, symbol, line in _imports(path):
            parts = set(module.lower().split("."))
            forbidden_module = module.startswith(FORBIDDEN_MODULE_PREFIXES) or bool(
                parts & FORBIDDEN_MODULE_PARTS
            )
            if forbidden_module or symbol in FORBIDDEN_SYMBOLS:
                violations.append(f"{path.relative_to(root)}:{line}:{module}:{symbol or ''}")
    return violations


def test_replay_package_has_no_live_bus_or_private_trading_imports() -> None:
    assert REPLAY_ROOT.is_dir()
    assert _forbidden_replay_imports(REPLAY_ROOT) == []


def test_replay_import_guard_fails_closed_for_forbidden_fixture(tmp_path: Path) -> None:
    package = tmp_path / "replay"
    package.mkdir()
    (package / "bad.py").write_text(
        "from app.data_engine.data_manager import DataManager\n"
        "from app.data_engine.data_manager.event_bus import EventBus\n"
        "from app.exchanges.private_trading import SignedOrderClient\n",
        encoding="utf-8",
    )
    violations = _forbidden_replay_imports(package)
    assert len(violations) == 3


def test_domain_models_and_errors_do_not_depend_on_transport_or_storage() -> None:
    for file_name in ("models.py", "errors.py"):
        domain_path = REPLAY_ROOT / file_name
        imported_modules = {
            module.split(".", 1)[0] for module, _, _ in _imports(domain_path)
        }
        assert imported_modules.isdisjoint(DOMAIN_FORBIDDEN_MODULES), file_name
