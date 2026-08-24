"""Deterministic, fail-closed Pyne subset for chart-first quick strategies.

This is a strategy provider, not the indicator runtime.  It accepts only a
small frozen grammar and never evaluates user text as Python.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping

from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
    canonical_hash,
)


CHART_PYNE_REVISION = "chart-pyne-v1"
CHART_PYNE_GRAMMAR = "candlescope.chart-pyne/1"
_NAME = r"[A-Za-z_][A-Za-z0-9_]*"
_NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)"
_STRATEGY = re.compile(r"^strategy\(\s*(['\"]).+?\1\s*\)$")
_SERIES = re.compile(
    rf"^({_NAME})\s*=\s*(?:ta\.)?(sma|rsi|highest|lowest)"
    rf"\(\s*(open|high|low|close)\s*,\s*(\d+)\s*\)$",
    re.IGNORECASE,
)
_CONSTANT = re.compile(rf"^({_NAME})\s*=\s*({_NUMBER})$")
_BRANCH = re.compile(r"^(if|else\s+if)\s+(.+)$", re.IGNORECASE)
_ELSE = re.compile(r"^else\s*$", re.IGNORECASE)
_TARGET = re.compile(rf"^target_position\(\s*({_NAME}|{_NUMBER})\s*\)$")
_CROSS = re.compile(rf"^(cross(?:over|under))\(\s*({_NAME})\s*,\s*({_NAME})\s*\)$", re.IGNORECASE)
_COMPARE = re.compile(r"^(.+?)\s*(<=|>=|==|!=|<|>)\s*(.+?)$")
_OPERAND = re.compile(
    rf"^(?:(open|high|low|close|{_NAME})(?:\[(\d+)\])?|({_NUMBER}))$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SeriesSpec:
    name: str
    function: str
    field: str
    length: int


@dataclass(frozen=True)
class Operand:
    name: str | None
    offset: int
    constant: Decimal | None


@dataclass(frozen=True)
class Condition:
    kind: str
    left: Operand
    right: Operand


@dataclass(frozen=True)
class Branch:
    condition: Condition | None
    target: Decimal
    line: int


@dataclass(frozen=True)
class ChartPyneProgram:
    series: tuple[SeriesSpec, ...]
    constants: Mapping[str, Decimal]
    branches: tuple[Branch, ...]
    max_lookback: int


def _diagnostic(line: int, column: int, message: str) -> dict[str, object]:
    return {
        "severity": "ERROR",
        "line": line,
        "column": column,
        "message": message,
        "next_step": "use a supported chart strategy statement and run again",
    }


def _fail(diagnostics: list[dict[str, object]]) -> None:
    raise StrategyProviderError(
        "PROVIDER_PROTOCOL_VIOLATION",
        json.dumps(diagnostics, ensure_ascii=False, separators=(",", ":")),
    )


def _parse_operand(text: str, known: set[str], *, line: int) -> Operand:
    match = _OPERAND.fullmatch(text.strip())
    if match is None:
        _fail([_diagnostic(line, 1, f"unsupported condition operand: {text.strip()}")])
    name, offset_text, number = match.groups()
    if number is not None:
        return Operand(name=None, offset=0, constant=Decimal(number))
    normalized = str(name).lower() if str(name).lower() in {"open", "high", "low", "close"} else str(name)
    if normalized not in known:
        _fail([_diagnostic(line, 1, f"unknown series or constant: {name}")])
    offset = int(offset_text or 0)
    if offset > 1:
        _fail([_diagnostic(line, 1, "chart strategy history references are limited to [1]")])
    return Operand(name=normalized, offset=offset, constant=None)


def _parse_condition(text: str, known: set[str], *, line: int) -> Condition:
    cross = _CROSS.fullmatch(text.strip())
    if cross is not None:
        kind, left, right = cross.groups()
        if left not in known or right not in known:
            _fail([_diagnostic(line, 1, "crossover operands must be declared series")])
        return Condition(
            kind=kind.lower(),
            left=Operand(left, 0, None),
            right=Operand(right, 0, None),
        )
    compare = _COMPARE.fullmatch(text.strip())
    if compare is None:
        _fail([_diagnostic(line, 1, f"unsupported condition: {text.strip()}")])
    left, operator, right = compare.groups()
    return Condition(
        kind=operator,
        left=_parse_operand(left, known, line=line),
        right=_parse_operand(right, known, line=line),
    )


def compile_chart_pyne(source: str) -> ChartPyneProgram:
    """Parse the frozen chart strategy grammar or return located diagnostics."""

    if not source.strip():
        _fail([_diagnostic(1, 1, "strategy source is required")])
    series: list[SeriesSpec] = []
    constants: dict[str, Decimal] = {}
    branches: list[Branch] = []
    known: set[str] = {"open", "high", "low", "close"}
    declaration_seen = False
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    diagnostics: list[dict[str, object]] = []
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        line = index + 1
        if not stripped or stripped.startswith("#") or stripped.startswith("//"):
            index += 1
            continue
        if _STRATEGY.fullmatch(stripped):
            if declaration_seen:
                diagnostics.append(_diagnostic(line, 1, "strategy may only be declared once"))
            declaration_seen = True
            index += 1
            continue
        series_match = _SERIES.fullmatch(stripped)
        if series_match is not None:
            name, function, field, length_text = series_match.groups()
            length = int(length_text)
            if name in known:
                diagnostics.append(_diagnostic(line, 1, f"duplicate name: {name}"))
            elif length < 2 or length > 10_000:
                diagnostics.append(_diagnostic(line, 1, "indicator length must be between 2 and 10000"))
            else:
                series.append(SeriesSpec(name, function.lower(), field.lower(), length))
                known.add(name)
            index += 1
            continue
        constant_match = _CONSTANT.fullmatch(stripped)
        if constant_match is not None:
            name, value = constant_match.groups()
            if name in known:
                diagnostics.append(_diagnostic(line, 1, f"duplicate name: {name}"))
            else:
                constants[name] = Decimal(value)
                known.add(name)
            index += 1
            continue
        branch_match = _BRANCH.fullmatch(stripped)
        is_else = _ELSE.fullmatch(stripped) is not None
        if branch_match is not None or is_else:
            condition = None if is_else else _parse_condition(branch_match.group(2), known, line=line)
            target_index = index + 1
            while target_index < len(lines) and not lines[target_index].strip():
                target_index += 1
            if target_index >= len(lines) or len(lines[target_index]) == len(lines[target_index].lstrip()):
                diagnostics.append(_diagnostic(line, 1, "condition must be followed by an indented target_position"))
                index += 1
                continue
            target_text = lines[target_index].strip()
            target_match = _TARGET.fullmatch(target_text)
            if target_match is None:
                diagnostics.append(_diagnostic(target_index + 1, 1, "only target_position is allowed inside a branch"))
                index = target_index + 1
                continue
            target_value = target_match.group(1)
            try:
                target = constants[target_value] if target_value in constants else Decimal(target_value)
            except (InvalidOperation, KeyError):
                diagnostics.append(_diagnostic(target_index + 1, 1, f"unknown target value: {target_value}"))
                index = target_index + 1
                continue
            if not target.is_finite() or abs(target) > Decimal("100"):
                diagnostics.append(_diagnostic(target_index + 1, 1, "target position must be finite and within -100..100"))
            else:
                branches.append(Branch(condition, target, line))
            index = target_index + 1
            continue
        diagnostics.append(_diagnostic(line, len(raw) - len(raw.lstrip()) + 1, f"unsupported statement: {stripped[:80]}"))
        index += 1
    if not declaration_seen:
        diagnostics.append(_diagnostic(1, 1, "strategy declaration is required"))
    if not branches:
        diagnostics.append(_diagnostic(1, 1, "at least one target_position branch is required"))
    if diagnostics:
        _fail(diagnostics)
    max_lookback = max([spec.length for spec in series] + [2]) + 2
    return ChartPyneProgram(tuple(series), dict(constants), tuple(branches), max_lookback)


class ChartPyneStrategyProvider:
    """Execute the frozen chart Pyne AST with bounded history."""

    def __init__(self) -> None:
        self._source = ""
        self._program: ChartPyneProgram | None = None
        self._bars: list[dict[str, Decimal]] = []
        self._series_history: dict[str, list[Decimal | None]] = {}
        self._last_sequence = 0
        self._last_target: Decimal | None = None

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("TARGET_POSITION",),
            reproducibility=("DETERMINISTIC",),
            signal_clock="BAR_CLOSE",
        )

    def prepare(self, context: Mapping[str, Any]) -> None:
        source = str(context.get("source") or "")
        self._program = compile_chart_pyne(source)
        self._source = source
        self._bars = []
        self._series_history = {spec.name: [] for spec in self._program.series}
        self._last_sequence = 0
        self._last_target = None

    @staticmethod
    def _decimal(value: object, field: str) -> Decimal:
        try:
            number = Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise StrategyProviderError("DATA_QUALITY_FAILED", f"bar {field} is not decimal") from exc
        if not number.is_finite():
            raise StrategyProviderError("DATA_QUALITY_FAILED", f"bar {field} is not finite")
        return number

    def _observe(self, frame: ObservationFrame) -> None:
        if self._program is None:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "provider is not prepared")
        bar = frame.bar or {}
        row = {name: self._decimal(bar.get(name), name) for name in ("open", "high", "low", "close")}
        self._bars.append(row)
        if len(self._bars) > self._program.max_lookback:
            self._bars.pop(0)
        for spec in self._program.series:
            values = [item[spec.field] for item in self._bars]
            value: Decimal | None = None
            if spec.function == "sma" and len(values) >= spec.length:
                value = sum(values[-spec.length :], Decimal("0")) / Decimal(spec.length)
            elif spec.function == "highest" and len(values) >= spec.length:
                value = max(values[-spec.length :])
            elif spec.function == "lowest" and len(values) >= spec.length:
                value = min(values[-spec.length :])
            elif spec.function == "rsi" and len(values) > spec.length:
                changes = [right - left for left, right in zip(values[-spec.length - 1 : -1], values[-spec.length :])]
                gains = sum((max(change, Decimal("0")) for change in changes), Decimal("0")) / Decimal(spec.length)
                losses = sum((max(-change, Decimal("0")) for change in changes), Decimal("0")) / Decimal(spec.length)
                value = Decimal("100") if losses == 0 else Decimal("100") - Decimal("100") / (Decimal("1") + gains / losses)
            history = self._series_history[spec.name]
            history.append(value)
            if len(history) > 2:
                history.pop(0)
        self._last_sequence = frame.sequence

    def _value(self, operand: Operand) -> Decimal | None:
        if operand.constant is not None:
            return operand.constant
        assert operand.name is not None
        if operand.name in {"open", "high", "low", "close"}:
            if len(self._bars) <= operand.offset:
                return None
            return self._bars[-1 - operand.offset][operand.name]
        history = self._series_history.get(operand.name) or []
        if len(history) <= operand.offset:
            return None
        return history[-1 - operand.offset]

    def _matches(self, condition: Condition | None) -> bool:
        if condition is None:
            return True
        left = self._value(condition.left)
        right = self._value(condition.right)
        if condition.kind in {"crossover", "crossunder"}:
            previous_left = self._value(Operand(condition.left.name, 1, None))
            previous_right = self._value(Operand(condition.right.name, 1, None))
            if None in {left, right, previous_left, previous_right}:
                return False
            assert left is not None and right is not None and previous_left is not None and previous_right is not None
            return previous_left <= previous_right and left > right if condition.kind == "crossover" else previous_left >= previous_right and left < right
        if left is None or right is None:
            return False
        return {
            "<": left < right,
            ">": left > right,
            "<=": left <= right,
            ">=": left >= right,
            "==": left == right,
            "!=": left != right,
        }[condition.kind]

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._observe(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._observe(frame)
        assert self._program is not None
        branch = next((item for item in self._program.branches if self._matches(item.condition)), None)
        if branch is None:
            return None
        self._last_target = branch.target
        payload = {
            "targetExposure": str(branch.target),
            "reasonCode": f"chart_pyne_line_{branch.line}",
            "grammarRevision": CHART_PYNE_GRAMMAR,
        }
        return StrategyOutput(
            sequence=frame.sequence,
            kind="TARGET_POSITION",
            payload=payload,
            state_hash=self._state_hash(),
            output_hash=canonical_hash(payload),
        )

    def on_execution_report(self, report: Mapping[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "execution report missing accepted")

    def _state_hash(self) -> str:
        return canonical_hash(
            {
                "sequence": self._last_sequence,
                "bars": [{key: str(value) for key, value in row.items()} for row in self._bars],
                "series": {
                    key: [None if value is None else str(value) for value in values]
                    for key, values in sorted(self._series_history.items())
                },
                "target": None if self._last_target is None else str(self._last_target),
            }
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "source": self._source,
            "bars": [{key: str(value) for key, value in row.items()} for row in self._bars],
            "series": {
                key: [None if value is None else str(value) for value in values]
                for key, values in self._series_history.items()
            },
            "lastSequence": self._last_sequence,
            "lastTarget": None if self._last_target is None else str(self._last_target),
        }

    def restore(self, payload: Mapping[str, Any]) -> None:
        self.prepare({"source": payload["source"]})
        self._bars = [
            {key: Decimal(str(value)) for key, value in dict(row).items()}
            for row in list(payload.get("bars") or [])
        ]
        self._series_history = {
            str(key): [None if value is None else Decimal(str(value)) for value in list(values)]
            for key, values in dict(payload.get("series") or {}).items()
        }
        self._last_sequence = int(payload.get("lastSequence") or 0)
        target = payload.get("lastTarget")
        self._last_target = None if target is None else Decimal(str(target))

    def close(self) -> str:
        return self._state_hash()

    def identity(self) -> dict[str, Any]:
        return {"grammarRevision": CHART_PYNE_GRAMMAR, "arbitraryCode": False}
