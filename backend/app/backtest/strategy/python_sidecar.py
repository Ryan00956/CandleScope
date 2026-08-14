"""Fail-closed local Python model adapter.

The v1 artifact is a deterministic ``predict`` function, not a general Python
environment. It is evaluated as a restricted expression tree in the Host.
Full wheel execution must use the Plugin Platform AppContainer runtime;
restricted builtins around ``exec`` are not a security boundary.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any, Mapping

from app.backtest.strategy.artifacts import ArtifactRegistry, ModelArtifact
from app.backtest.strategy.external import (
    assert_no_lookahead,
    assert_output_allowed,
    evidence_record,
    signal_from_score,
)
from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
)

FORBIDDEN_MODULES = frozenset(
    {
        "socket",
        "requests",
        "httpx",
        "aiohttp",
        "urllib",
        "http.client",
        "http",
        "subprocess",
        "os",
    }
)
_PURE_FUNCTIONS = {
    "abs": abs,
    "min": min,
    "max": max,
    "sum": sum,
    "round": round,
    "float": float,
    "int": int,
    "bool": bool,
    "len": len,
}
_ALLOWED_EXPRESSION_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.IfExp,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.List,
    ast.Tuple,
    ast.Subscript,
    ast.Slice,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.And,
    ast.Or,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
)


def assert_wheel_is_offline(source: str) -> None:
    _restricted_predict_expression(ast.parse(source))


class PythonSidecarProvider:
    def __init__(self, registry: ArtifactRegistry, artifact_id: str, *, source_dir: Path) -> None:
        self._registry = registry
        self._artifact_id = artifact_id
        self._source_dir = Path(source_dir)
        self._artifact: ModelArtifact | None = None
        self._source = ""
        self._predict: Any = None
        self._seen: list[int] = []
        self.evidence: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL",),
            reproducibility=("DETERMINISTIC", "SEEDED"),
        )

    def prepare(self, context: Mapping[str, Any]) -> None:
        artifact, payload = self._registry.get(self._artifact_id)
        if artifact.format != "PYTHON_WHEEL":
            raise StrategyProviderError("FIDELITY_UNSUPPORTED", "artifact is not PYTHON_WHEEL")
        try:
            source = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "general Python wheels require the AppContainer runtime",
            ) from exc
        self._predict = _compile_predict(source)
        self._artifact = artifact
        self._source = source
        self._seen = []
        self.evidence = {
            **evidence_record(artifact, sidecar=str(self._source_dir)),
            "execution_boundary": "restricted-expression-v1",
            "network": "denied-by-construction",
            "filesystem": "denied-by-construction",
        }

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._score(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        score = self._score(frame)
        output = signal_from_score(frame.sequence, score, state=self._seen)
        assert_output_allowed(output, self.describe())
        return output

    def on_execution_report(self, report: Mapping[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "report missing accepted")

    def snapshot(self) -> dict[str, Any]:
        return {"seen": list(self._seen)}

    def restore(self, payload: Mapping[str, Any]) -> None:
        self.prepare({})
        self._seen = [int(value) for value in payload.get("seen") or []]

    def close(self) -> str:
        return self.evidence.get("artifact_hash") or ""

    def identity(self) -> dict[str, Any]:
        return dict(self.evidence)

    def _score(self, frame: ObservationFrame) -> str:
        artifact = self._require()
        assert_no_lookahead(frame, artifact)
        if self._predict is None:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "prepare first")
        values = artifact.feature_schema.ordered_values(frame.features)
        self._seen.append(frame.sequence)
        numbers = [float(value) for value in values]
        try:
            score = self._predict(*numbers)
        except Exception as exc:
            raise StrategyProviderError(
                "PROVIDER_CRASH_UNRECOVERABLE",
                "restricted model evaluation failed",
            ) from exc
        return str(score)

    def _require(self) -> ModelArtifact:
        if self._artifact is None:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "prepare first")
        return self._artifact


def _compile_predict(source: str) -> Any:
    expression, parameter_names = _restricted_predict_expression(ast.parse(source))
    code = compile(ast.Expression(expression), "<restricted-model>", "eval")

    def predict(*values: object) -> object:
        if len(values) != len(parameter_names):
            raise TypeError(
                f"predict expects {len(parameter_names)} features, received {len(values)}"
            )
        locals_map = dict(zip(parameter_names, values, strict=True))
        return eval(code, {"__builtins__": {}, **_PURE_FUNCTIONS}, locals_map)

    return predict


def _restricted_predict_expression(tree: ast.Module) -> tuple[ast.expr, tuple[str, ...]]:
    imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    if imports:
        imported: set[str] = set()
        for node in imports:
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif node.module:
                imported.add(node.module.split(".", 1)[0])
        blocked = sorted(imported & FORBIDDEN_MODULES)
        raise StrategyProviderError(
            "PROVIDER_UNAUTHORIZED_WRITE",
            f"python sidecar cannot import {blocked or sorted(imported)}",
        )
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if len(tree.body) != 1 or len(functions) != 1 or functions[0].name != "predict":
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION",
            "restricted model must contain exactly one predict() function",
        )
    function = functions[0]
    if (
        function.decorator_list
        or function.returns is not None
        or function.args.vararg is not None
        or function.args.kwarg is not None
        or function.args.kwonlyargs
        or function.args.defaults
        or function.args.posonlyargs
        or len(function.body) != 1
        or not isinstance(function.body[0], ast.Return)
        or function.body[0].value is None
    ):
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION",
            "predict() must be a single return expression with positional arguments",
        )
    parameter_names = tuple(argument.arg for argument in function.args.args)
    if not parameter_names or len(set(parameter_names)) != len(parameter_names):
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION",
            "predict() arguments must be unique",
        )
    expression = function.body[0].value
    nodes = list(ast.walk(expression))
    if len(nodes) > 128:
        raise StrategyProviderError(
            "BUDGET_EXCEEDED",
            "restricted model expression exceeds the node ceiling",
        )
    allowed_names = set(parameter_names) | set(_PURE_FUNCTIONS)
    for node in nodes:
        if not isinstance(node, _ALLOWED_EXPRESSION_NODES):
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                f"restricted model does not allow {type(node).__name__}",
            )
        if isinstance(node, ast.Name) and node.id not in allowed_names:
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                f"restricted model cannot access {node.id}",
            )
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _PURE_FUNCTIONS:
                raise StrategyProviderError(
                    "PROVIDER_UNAUTHORIZED_WRITE",
                    "restricted model may call only approved pure functions",
                )
            if node.keywords:
                raise StrategyProviderError(
                    "PROVIDER_PROTOCOL_VIOLATION",
                    "restricted model calls do not accept keyword arguments",
                )
            if len(node.args) > 16:
                raise StrategyProviderError(
                    "BUDGET_EXCEEDED",
                    "restricted model call exceeds the argument ceiling",
                )
        if isinstance(node, ast.Subscript) and not isinstance(
            node.value, (ast.Name, ast.List, ast.Tuple)
        ):
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                "restricted model subscripts may target only feature values",
            )
        if isinstance(node, (ast.List, ast.Tuple)) and len(node.elts) > 64:
            raise StrategyProviderError(
                "BUDGET_EXCEEDED",
                "restricted model literal exceeds the element ceiling",
            )
        if isinstance(node, ast.Constant):
            value = node.value
            if isinstance(value, (int, float)) and (
                abs(value) > 1_000_000_000_000
                or (isinstance(value, float) and value != value)
            ):
                raise StrategyProviderError(
                    "BUDGET_EXCEEDED",
                    "restricted model numeric literal exceeds the safe ceiling",
                )
    return expression, parameter_names
