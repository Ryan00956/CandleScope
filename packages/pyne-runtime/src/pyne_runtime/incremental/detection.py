"""Incremental script detection helpers."""
from __future__ import annotations

import ast


def is_incremental_pyne_script(script: str) -> bool:
    try:
        tree = ast.parse(script)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {
            "on_bar",
            "on_preview",
        }:
            return True
        if isinstance(node, ast.Call) and _call_name(node.func) == "indicator":
            for kw in node.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    if str(kw.value.value).lower() == "incremental":
                        return True
    return False


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""
