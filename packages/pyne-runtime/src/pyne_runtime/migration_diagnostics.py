"""Static diagnostics for common Pine-to-Pyne migration mistakes."""
from __future__ import annotations

import ast
import re
from typing import Any

from .errors import DOCS_BASE_URL, error_detail


_COOKBOOK_DOCS_URL = f"{DOCS_BASE_URL}/tutorials/pine_to_pyne_cookbook.md"
_SERIES_NAMES = {
    "open",
    "high",
    "low",
    "close",
    "volume",
    "time",
    "time_close",
    "bar_index",
    "last_bar_index",
    "hl2",
    "hlc3",
    "ohlc4",
    "hlcc4",
}
_REQUEST_NAMES = {"security", "security_lower_tf"}
_SHIFT_NAMES = {"shift", "ref"}


def syntax_migration_diagnostics(script: str) -> list[dict[str, Any]]:
    """Return migration diagnostics that can be detected even after SyntaxError."""
    diagnostics: list[dict[str, Any]] = []
    for match in re.finditer(r"\barray\s*\.\s*from\s*\(", script):
        line = script.count("\n", 0, match.start()) + 1
        line_start = script.rfind("\n", 0, match.start()) + 1
        diagnostics.append(
            error_detail(
                "PYNE_MIGRATION_HINT",
                "array.from(...) is not valid Python syntax because from is a keyword.",
                line=line,
                column=match.start() - line_start + 1,
                hint="Use array.from_values(...) or array.from_list(...) instead.",
                docs_url=_COOKBOOK_DOCS_URL,
            )
        )
    return diagnostics


def migration_diagnostics(script: str) -> list[dict[str, Any]]:
    """Return AST-based migration diagnostics for syntactically valid scripts."""
    tree = ast.parse(script)
    visitor = _MigrationDiagnosticVisitor()
    visitor.visit(tree)
    return visitor.diagnostics


class _MigrationDiagnosticVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.diagnostics: list[dict[str, Any]] = []

    def visit_If(self, node: ast.If) -> None:
        if _looks_series_expr(node.test):
            self._append(
                node.test,
                "Series conditions cannot be used directly in Python if statements.",
                "Use when(condition, true_value, false_value) for values, or "
                "switch((condition, value), default=...) for prioritized branches.",
            )
        self.generic_visit(node)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        if _looks_series_expr(node.test):
            self._append(
                node.test,
                "Series conditions cannot be used directly in Python ternary expressions.",
                "Use when(condition, true_value, false_value) instead of "
                "true_value if condition else false_value.",
            )
        self.generic_visit(node)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        if _looks_series_expr(node):
            operator = "and" if isinstance(node.op, ast.And) else "or"
            replacement = "&" if isinstance(node.op, ast.And) else "|"
            self._append(
                node,
                f"Python '{operator}' cannot compose per-bar series conditions.",
                f"Use '{replacement}' with parenthesized comparisons, for example "
                "(close > open) & (close > close[1]).",
            )
        self.generic_visit(node)

    def visit_UnaryOp(self, node: ast.UnaryOp) -> None:
        if isinstance(node.op, ast.Not) and _looks_series_expr(node.operand):
            self._append(
                node,
                "Python 'not' cannot invert a per-bar series condition.",
                "Use '~' with a parenthesized comparison, for example ~(close > open).",
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if _is_request_call(node) and len(node.args) >= 3:
            expression = node.args[2]
            if _looks_unsupported_request_expression(expression):
                self._append(
                    expression,
                    "request.security() cannot recalculate an already evaluated Python expression.",
                    "Pass a callable thunk such as lambda ctx: ctx.ta.ema(ctx.close, 20), "
                    "or pass a plain field like close, close[1], or \"close\".",
                )
        if _is_shift_call(node) and _call_uses_negative_period(node):
            self._append(
                node,
                "Negative history offsets look forward and are not supported.",
                "Use non-negative bars-back references such as close[1] or shift(close, 1).",
            )
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if _is_field_expression(node.value) and _is_negative_int(node.slice):
            self._append(
                node,
                "Negative history references look forward and are not supported.",
                "Use non-negative bars-back references such as close[1].",
            )
        self.generic_visit(node)

    def _append(self, node: ast.AST, message: str, hint: str) -> None:
        self.diagnostics.append(
            error_detail(
                "PYNE_MIGRATION_HINT",
                message,
                line=getattr(node, "lineno", None),
                column=getattr(node, "col_offset", None),
                hint=hint,
                docs_url=_COOKBOOK_DOCS_URL,
            )
        )


def _is_request_call(node: ast.Call) -> bool:
    func = node.func
    return (
        isinstance(func, ast.Attribute)
        and func.attr in _REQUEST_NAMES
        and isinstance(func.value, ast.Name)
        and func.value.id == "request"
    )


def _is_shift_call(node: ast.Call) -> bool:
    func = node.func
    return isinstance(func, ast.Name) and func.id in _SHIFT_NAMES


def _call_uses_negative_period(node: ast.Call) -> bool:
    if len(node.args) >= 2 and _is_negative_int(node.args[1]):
        return True
    for keyword in node.keywords:
        if keyword.arg in {"period", "periods", "offset"} and _is_negative_int(keyword.value):
            return True
    return False


def _is_negative_int(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return isinstance(node.value, int) and not isinstance(node.value, bool) and node.value < 0
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return (
            isinstance(node.operand, ast.Constant)
            and isinstance(node.operand.value, int)
            and not isinstance(node.operand.value, bool)
        )
    return False


def _looks_unsupported_request_expression(node: ast.AST) -> bool:
    if isinstance(node, ast.Lambda):
        return False
    if _is_field_expression(node):
        return False
    if isinstance(node, ast.Tuple | ast.List):
        return any(_looks_unsupported_request_expression(item) for item in node.elts)
    return isinstance(node, ast.Call | ast.BinOp | ast.BoolOp | ast.Compare | ast.UnaryOp)


def _is_field_expression(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value in _SERIES_NAMES
    if isinstance(node, ast.Name):
        return node.id in _SERIES_NAMES
    if isinstance(node, ast.Subscript):
        return _is_field_expression(node.value)
    return False


def _looks_series_expr(node: ast.AST) -> bool:
    if isinstance(node, ast.Name):
        return node.id in _SERIES_NAMES
    if isinstance(node, ast.Subscript):
        return _is_field_expression(node.value) or _looks_series_expr(node.value)
    if isinstance(node, ast.Attribute):
        return isinstance(node.value, ast.Name) and node.value.id in {"barstate", "timeframe", "syminfo", "session"}
    if isinstance(node, ast.Compare):
        return _looks_series_expr(node.left) or any(_looks_series_expr(item) for item in node.comparators)
    if isinstance(node, ast.BinOp | ast.BoolOp):
        return any(_looks_series_expr(child) for child in ast.iter_child_nodes(node))
    if isinstance(node, ast.UnaryOp):
        return _looks_series_expr(node.operand)
    if isinstance(node, ast.Call):
        return _looks_series_call(node) or any(_looks_series_expr(arg) for arg in node.args)
    return False


def _looks_series_call(node: ast.Call) -> bool:
    func = node.func
    if isinstance(func, ast.Attribute):
        return isinstance(func.value, ast.Name) and func.value.id in {"ta", "math"}
    if isinstance(func, ast.Name):
        return func.id in {
            "crossover",
            "crossunder",
            "cross",
            "highest",
            "lowest",
            "change",
            "roc",
            "barssince",
            "valuewhen",
            "shift",
            "ref",
            "na",
            "nz",
        }
    return False
