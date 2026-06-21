from __future__ import annotations

import ast
import importlib
import warnings
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "pyne_runtime"
HOST_IMPORT_PREFIXES = ("app", "candlescope")
MODULE_SIZE_WARNING_LINES = 1_500


def _python_files() -> list[Path]:
    return sorted(PACKAGE_ROOT.rglob("*.py"))


def _module_name(path: Path) -> str:
    relative = path.relative_to(PACKAGE_ROOT).with_suffix("")
    parts = list(relative.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _package_modules() -> dict[str, Path]:
    modules: dict[str, Path] = {}
    for path in _python_files():
        name = _module_name(path)
        if name:
            modules[name] = path
    return modules


def _imported_names(node: ast.ImportFrom, current_module: str, *, is_package: bool) -> list[str]:
    if node.level == 0:
        return [node.module] if node.module else []

    current_parts = current_module.split(".") if current_module else []
    trim_count = node.level - 1 if is_package else node.level
    package_parts = (
        current_parts[: len(current_parts) - trim_count]
        if trim_count
        else current_parts[:]
    )
    if node.module:
        package_parts.extend(node.module.split("."))

    base_name = ".".join(package_parts)
    if node.module:
        return [base_name]
    return [f"{base_name}.{alias.name}" if base_name else alias.name for alias in node.names]


def _resolve_internal_module(import_name: str | None, modules: dict[str, Path]) -> str | None:
    if not import_name:
        return None

    if import_name == "pyne_runtime":
        return None

    if import_name.startswith("pyne_runtime."):
        import_name = import_name.removeprefix("pyne_runtime.")

    parts = import_name.split(".")
    while parts:
        candidate = ".".join(parts)
        if candidate in modules:
            return candidate
        parts.pop()
    return None


def _internal_import_graph() -> dict[str, set[str]]:
    modules = _package_modules()
    graph: dict[str, set[str]] = {name: set() for name in modules}

    for module_name, path in modules.items():
        if module_name == "__main__":
            continue

        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue

            if isinstance(node, ast.ImportFrom):
                for import_name in _imported_names(
                    node,
                    module_name,
                    is_package=path.name == "__init__.py",
                ):
                    dependency = _resolve_internal_module(import_name, modules)
                    if dependency and dependency != module_name:
                        graph[module_name].add(dependency)
                continue

            for alias in node.names:
                dependency = _resolve_internal_module(alias.name, modules)
                if dependency and dependency != module_name:
                    graph[module_name].add(dependency)

    graph.pop("__main__", None)
    return graph


def _find_cycles(graph: dict[str, set[str]]) -> list[tuple[str, ...]]:
    visited: set[str] = set()
    visiting: set[str] = set()
    stack: list[str] = []
    cycles: set[tuple[str, ...]] = set()

    def visit(module_name: str) -> None:
        if module_name in visiting:
            cycle = stack[stack.index(module_name) :] + [module_name]
            rotated = min(
                tuple(cycle[index:] + cycle[1:index + 1])
                for index in range(len(cycle) - 1)
            )
            cycles.add(rotated)
            return
        if module_name in visited:
            return

        visiting.add(module_name)
        stack.append(module_name)
        for dependency in sorted(graph[module_name]):
            visit(dependency)
        stack.pop()
        visiting.remove(module_name)
        visited.add(module_name)

    for module_name in sorted(graph):
        visit(module_name)

    return sorted(cycles)


def test_public_exports_are_importable() -> None:
    import pyne_runtime as pn

    assert pn.__all__
    for name in pn.__all__:
        assert hasattr(pn, name), name


def test_public_export_modules_are_importable() -> None:
    import pyne_runtime as pn

    for name in pn.__all__:
        exported = getattr(pn, name)
        module_name = getattr(exported, "__module__", None)
        if module_name and module_name.startswith("pyne_runtime"):
            importlib.import_module(module_name)


def test_core_package_does_not_import_host_app_modules() -> None:
    violations: list[str] = []

    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root_name = alias.name.split(".", 1)[0].lower()
                    if root_name in HOST_IMPORT_PREFIXES:
                        violations.append(f"{path.relative_to(PACKAGE_ROOT)} imports {alias.name}")
            elif isinstance(node, ast.ImportFrom) and node.module:
                root_name = node.module.split(".", 1)[0].lower()
                if root_name in HOST_IMPORT_PREFIXES:
                    violations.append(f"{path.relative_to(PACKAGE_ROOT)} imports {node.module}")

    assert violations == []


def test_internal_import_graph_has_no_cycles() -> None:
    cycles = _find_cycles(_internal_import_graph())

    assert cycles == []


def test_large_modules_emit_architecture_warning() -> None:
    line_counts = {
        path.relative_to(PACKAGE_ROOT).as_posix(): len(
            path.read_text(encoding="utf-8").splitlines()
        )
        for path in _python_files()
    }
    large_modules = {
        path: count
        for path, count in line_counts.items()
        if count >= MODULE_SIZE_WARNING_LINES
    }

    if large_modules:
        report = ", ".join(
            f"{path} ({count} lines)" for path, count in sorted(large_modules.items())
        )
        warnings.warn(
            f"Large pyne_runtime modules may need architecture review: {report}",
            stacklevel=2,
        )


def test_module_size_report_is_available() -> None:
    line_counts: dict[str, int] = {}
    for path in _python_files():
        line_counts[path.relative_to(PACKAGE_ROOT).as_posix()] = len(
            path.read_text(encoding="utf-8").splitlines()
        )

    assert line_counts