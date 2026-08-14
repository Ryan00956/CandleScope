"""Small first-party strategy providers available without an external plugin install."""

from __future__ import annotations

import ast
import json
from decimal import Decimal
from typing import Any

from .protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyProvider,
    StrategyOutput,
    StrategyProviderError,
    canonical_hash,
)

BUILTIN_SMA_REVISION = "builtin-sma-cross-v1"
BUILTIN_RSI_REVISION = "builtin-rsi-reversion-v1"
BUILTIN_RSI_WILDER_LONG_SHORT_REVISION = "builtin-rsi-wilder-long-short-v1"
BUILTIN_EXPRESSION_REVISION = "builtin-expression-model-v1"
BUILTIN_ORDER_COMMAND_REVISION = "builtin-order-command-v1"

_PURE_FUNCTIONS = {
    "abs": abs,
    "min": min,
    "max": max,
    "float": float,
}
_FEATURE_NAMES = frozenset({"open", "high", "low", "close", "volume", "price"})
_EXPRESSION_NODES = (
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
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
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


class BuiltinSmaCrossProvider:
    """Deterministic BAR-close SMA cross used by the standalone workbench MVP."""

    def __init__(self) -> None:
        self._fast = 3
        self._slow = 5
        self._closes: list[Decimal] = []
        self._prepared = False

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("TARGET_POSITION",),
            reproducibility=("DETERMINISTIC",),
        )

    def identity(self) -> dict[str, Any]:
        return {
            "revision": BUILTIN_SMA_REVISION,
            "fast": self._fast,
            "slow": self._slow,
        }

    def prepare(self, context: dict[str, Any]) -> None:
        parameters = context.get("parameters") or {}
        if not isinstance(parameters, dict):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "parameters must be an object",
            )
        try:
            fast = int(parameters.get("fast", 3))
            slow = int(parameters.get("slow", 5))
        except (TypeError, ValueError) as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "SMA lengths must be integers",
            ) from exc
        if fast < 1 or slow < 2 or fast >= slow or slow > 5_000:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "SMA lengths require 1 <= fast < slow <= 5000",
            )
        self._fast = fast
        self._slow = slow
        self._closes = []
        self._prepared = True

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._append(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._append(frame)
        if len(self._closes) < self._slow + 1:
            return None
        fast_now = _mean(self._closes[-self._fast :])
        slow_now = _mean(self._closes[-self._slow :])
        fast_previous = _mean(self._closes[-self._fast - 1 : -1])
        slow_previous = _mean(self._closes[-self._slow - 1 : -1])
        if fast_previous <= slow_previous and fast_now > slow_now:
            target = "1"
            reason = "sma_cross_up"
        elif fast_previous >= slow_previous and fast_now < slow_now:
            target = "0"
            reason = "sma_cross_down"
        else:
            return None
        payload = {"targetExposure": target, "reasonCode": reason}
        return StrategyOutput(
            sequence=frame.sequence,
            kind="TARGET_POSITION",
            payload=payload,
            state_hash=canonical_hash([str(value) for value in self._closes]),
            output_hash=canonical_hash(
                {"sequence": frame.sequence, "kind": "TARGET_POSITION", "payload": payload}
            ),
        )

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "execution report must declare accepted",
            )

    def snapshot(self) -> dict[str, Any]:
        return {
            "fast": self._fast,
            "slow": self._slow,
            "closes": [str(value) for value in self._closes],
        }

    def restore(self, payload: dict[str, Any]) -> None:
        self._fast = int(payload["fast"])
        self._slow = int(payload["slow"])
        self._closes = [Decimal(str(value)) for value in payload["closes"]]
        self._prepared = True

    def close(self) -> str:
        return canonical_hash(self.snapshot())

    def _append(self, frame: ObservationFrame) -> None:
        if not self._prepared or frame.bar is None:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "prepared BAR input is required",
            )
        try:
            close = Decimal(str(frame.bar["close"]))
        except (KeyError, ValueError) as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "bar close must be Decimal-compatible",
            ) from exc
        if not close.is_finite() or close <= 0:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "bar close must be finite and positive",
            )
        self._closes.append(close)


class BuiltinRsiReversionProvider:
    """Stateful RSI strategy exposed through the same provider protocol."""

    def __init__(self) -> None:
        self._length = 14
        self._oversold = Decimal("30")
        self._overbought = Decimal("70")
        self._closes: list[Decimal] = []

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("TARGET_POSITION",),
            reproducibility=("DETERMINISTIC",),
        )

    def identity(self) -> dict[str, Any]:
        return {
            "revision": BUILTIN_RSI_REVISION,
            "length": self._length,
            "oversold": str(self._oversold),
            "overbought": str(self._overbought),
        }

    def prepare(self, context: dict[str, Any]) -> None:
        parameters = context.get("parameters") or {}
        try:
            length = int(parameters.get("length", 14))
            oversold = Decimal(str(parameters.get("oversold", "30")))
            overbought = Decimal(str(parameters.get("overbought", "70")))
        except (TypeError, ValueError) as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "invalid RSI parameters"
            ) from exc
        if length < 2 or length > 5_000 or not (Decimal("0") < oversold < overbought < Decimal("100")):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "RSI requires length >= 2 and 0 < oversold < overbought < 100",
            )
        self._length = length
        self._oversold = oversold
        self._overbought = overbought
        self._closes = []

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._append(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._append(frame)
        if len(self._closes) < self._length + 1:
            return None
        changes = [
            right - left
            for left, right in zip(
                self._closes[-self._length - 1 : -1],
                self._closes[-self._length :],
                strict=True,
            )
        ]
        gains = sum((max(change, Decimal("0")) for change in changes), Decimal("0"))
        losses = sum((max(-change, Decimal("0")) for change in changes), Decimal("0"))
        if losses == 0:
            rsi = Decimal("100")
        else:
            relative_strength = gains / losses
            rsi = Decimal("100") - Decimal("100") / (Decimal("1") + relative_strength)
        if rsi <= self._oversold:
            target, reason = "1", "rsi_oversold"
        elif rsi >= self._overbought:
            target, reason = "0", "rsi_overbought"
        else:
            return None
        payload = {"targetExposure": target, "reasonCode": reason, "rsi": str(rsi)}
        return StrategyOutput(
            sequence=frame.sequence,
            kind="TARGET_POSITION",
            payload=payload,
            state_hash=canonical_hash([str(value) for value in self._closes]),
            output_hash=canonical_hash({"sequence": frame.sequence, "payload": payload}),
        )

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "execution report must declare accepted"
            )

    def snapshot(self) -> dict[str, Any]:
        return {
            "length": self._length,
            "oversold": str(self._oversold),
            "overbought": str(self._overbought),
            "closes": [str(value) for value in self._closes],
        }

    def restore(self, payload: dict[str, Any]) -> None:
        self._length = int(payload["length"])
        self._oversold = Decimal(str(payload["oversold"]))
        self._overbought = Decimal(str(payload["overbought"]))
        self._closes = [Decimal(str(value)) for value in payload["closes"]]

    def close(self) -> str:
        return canonical_hash(self.snapshot())

    def _append(self, frame: ObservationFrame) -> None:
        if frame.bar is None:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "RSI requires BAR input"
            )
        close = Decimal(str(frame.bar["close"]))
        if not close.is_finite() or close <= 0:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "bar close must be finite and positive"
            )
        self._closes.append(close)


class BuiltinRsiWilderLongShortProvider:
    """Frozen close-only Wilder RSI LEVEL_TARGET strategy revision."""

    _TRACE_LIMIT = 10_000

    def __init__(self) -> None:
        self._length = 24
        self._oversold = Decimal("30")
        self._overbought = Decimal("70")
        self._trigger_mode = "LEVEL_TARGET_V1"
        self._debug_trace_enabled = False
        self._last_close: Decimal | None = None
        self._seed_count = 0
        self._seed_gain = Decimal("0")
        self._seed_loss = Decimal("0")
        self._avg_gain: Decimal | None = None
        self._avg_loss: Decimal | None = None
        self._last_rsi: Decimal | None = None
        self._target_direction = "FLAT"
        self._observed_rows = 0
        self._warmup_rows = 0
        self._reason_counts: dict[str, int] = {}
        self._debug_trace: list[dict[str, object]] = []
        self._prepared = False

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL",),
            reproducibility=("DETERMINISTIC",),
            signal_clock="BAR_CLOSE",
            required_features=("close",),
            warmup_requirement={
                "kind": "PARAMETER_PLUS_ROWS",
                "parameter": "length",
                "offset": 1,
                "minimum": 3,
            },
        )

    def identity(self) -> dict[str, Any]:
        return {
            "revision": BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
            "indicatorRevision": "wilder-rsi-close-v1",
            "length": self._length,
            "oversold": str(self._oversold),
            "overbought": str(self._overbought),
            "triggerMode": self._trigger_mode,
            "debugTrace": self._debug_trace_enabled,
        }

    def report_metadata(self) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            **self.identity(),
            "signalClock": "BAR_CLOSE",
            "requiredFeatures": ["close"],
            "warmupRequirementRows": self._length + 1,
            "warmupRowsObserved": self._warmup_rows,
            "observedRows": self._observed_rows,
            "reasonCodes": dict(sorted(self._reason_counts.items())),
        }
        if self._debug_trace_enabled:
            metadata["decisionDebugTrace"] = [dict(item) for item in self._debug_trace]
        return metadata

    def prepare(self, context: dict[str, Any]) -> None:
        parameters = context.get("parameters") or {}
        if not isinstance(parameters, dict):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "parameters must be an object"
            )
        roles = tuple(str(value) for value in (context.get("roles") or ()))
        if roles and roles != ("BARS",):
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "this revision requires completed BAR_CLOSE input; dual-clock execution is not M1",
            )
        try:
            length = int(parameters.get("length", 24))
            oversold = Decimal(str(parameters.get("oversold", "30")))
            overbought = Decimal(str(parameters.get("overbought", "70")))
        except (TypeError, ValueError) as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "invalid Wilder RSI parameters"
            ) from exc
        trigger_mode = str(parameters.get("trigger_mode", "LEVEL_TARGET_V1"))
        debug_trace = parameters.get("debug_trace", False)
        if not isinstance(debug_trace, bool):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "debug_trace must be boolean"
            )
        if (
            length < 2
            or length > 5_000
            or not oversold.is_finite()
            or not overbought.is_finite()
            or not (Decimal("0") < oversold < overbought < Decimal("100"))
        ):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "Wilder RSI requires 2 <= length <= 5000 and 0 < oversold < overbought < 100",
            )
        if trigger_mode != "LEVEL_TARGET_V1":
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "this immutable revision supports only LEVEL_TARGET_V1",
            )
        self._length = length
        self._oversold = oversold
        self._overbought = overbought
        self._trigger_mode = trigger_mode
        self._debug_trace_enabled = debug_trace
        self._reset_runtime_state()
        self._prepared = True

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._warmup_rows += 1
        self._update(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        rsi = self._update(frame)
        if rsi is None:
            return None
        direction: str | None = None
        reason: str | None = None
        if rsi <= self._oversold:
            direction, reason = "LONG", "RSI_LEVEL_LONG"
        elif rsi >= self._overbought:
            direction, reason = "SHORT", "RSI_LEVEL_SHORT"
        if direction is not None and reason is not None:
            self._target_direction = direction
            self._reason_counts[reason] = self._reason_counts.get(reason, 0) + 1
        self._record_trace(frame, rsi=rsi, direction=direction, reason=reason)
        if direction is None or reason is None:
            return None
        payload = {
            "direction": direction,
            "normalizedTarget": "1" if direction == "LONG" else "-1",
            "reasonCode": reason,
            "rsi": str(rsi),
        }
        return StrategyOutput(
            sequence=frame.sequence,
            kind="SIGNAL",
            payload=payload,
            state_hash=canonical_hash(self.snapshot()),
            output_hash=canonical_hash(
                {"sequence": frame.sequence, "kind": "SIGNAL", "payload": payload}
            ),
        )

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "execution report must declare accepted"
            )

    def snapshot(self) -> dict[str, Any]:
        return {
            "length": self._length,
            "oversold": str(self._oversold),
            "overbought": str(self._overbought),
            "trigger_mode": self._trigger_mode,
            "debug_trace_enabled": self._debug_trace_enabled,
            "last_close": None if self._last_close is None else str(self._last_close),
            "seed_count": self._seed_count,
            "seed_gain": str(self._seed_gain),
            "seed_loss": str(self._seed_loss),
            "avg_gain": None if self._avg_gain is None else str(self._avg_gain),
            "avg_loss": None if self._avg_loss is None else str(self._avg_loss),
            "last_rsi": None if self._last_rsi is None else str(self._last_rsi),
            "target_direction": self._target_direction,
            "observed_rows": self._observed_rows,
            "warmup_rows": self._warmup_rows,
            "reason_counts": dict(sorted(self._reason_counts.items())),
            "debug_trace": [dict(item) for item in self._debug_trace],
        }

    def restore(self, payload: dict[str, Any]) -> None:
        self._length = int(payload["length"])
        self._oversold = Decimal(str(payload["oversold"]))
        self._overbought = Decimal(str(payload["overbought"]))
        self._trigger_mode = str(payload["trigger_mode"])
        self._debug_trace_enabled = bool(payload["debug_trace_enabled"])
        self._last_close = _optional_decimal_value(payload.get("last_close"))
        self._seed_count = int(payload["seed_count"])
        self._seed_gain = Decimal(str(payload["seed_gain"]))
        self._seed_loss = Decimal(str(payload["seed_loss"]))
        self._avg_gain = _optional_decimal_value(payload.get("avg_gain"))
        self._avg_loss = _optional_decimal_value(payload.get("avg_loss"))
        self._last_rsi = _optional_decimal_value(payload.get("last_rsi"))
        self._target_direction = str(payload["target_direction"])
        self._observed_rows = int(payload["observed_rows"])
        self._warmup_rows = int(payload["warmup_rows"])
        self._reason_counts = {
            str(key): int(value) for key, value in dict(payload["reason_counts"]).items()
        }
        self._debug_trace = [dict(item) for item in list(payload["debug_trace"])]
        self._prepared = True

    def close(self) -> str:
        return canonical_hash(self.snapshot())

    def _reset_runtime_state(self) -> None:
        self._last_close = None
        self._seed_count = 0
        self._seed_gain = Decimal("0")
        self._seed_loss = Decimal("0")
        self._avg_gain = None
        self._avg_loss = None
        self._last_rsi = None
        self._target_direction = "FLAT"
        self._observed_rows = 0
        self._warmup_rows = 0
        self._reason_counts = {}
        self._debug_trace = []

    def _update(self, frame: ObservationFrame) -> Decimal | None:
        if not self._prepared or frame.bar is None or "close" not in frame.bar:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "prepared completed BAR close is required"
            )
        try:
            close = Decimal(str(frame.bar["close"]))
        except (ValueError, TypeError) as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "bar close must be Decimal-compatible"
            ) from exc
        if not close.is_finite() or close <= 0:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "bar close must be finite and positive"
            )
        self._observed_rows += 1
        if self._last_close is None:
            self._last_close = close
            self._last_rsi = None
            return None
        change = close - self._last_close
        gain = max(change, Decimal("0"))
        loss = max(-change, Decimal("0"))
        self._last_close = close
        if self._avg_gain is None or self._avg_loss is None:
            self._seed_count += 1
            self._seed_gain += gain
            self._seed_loss += loss
            if self._seed_count < self._length:
                self._last_rsi = None
                return None
            divisor = Decimal(self._length)
            self._avg_gain = self._seed_gain / divisor
            self._avg_loss = self._seed_loss / divisor
        else:
            length = Decimal(self._length)
            self._avg_gain = (self._avg_gain * (length - 1) + gain) / length
            self._avg_loss = (self._avg_loss * (length - 1) + loss) / length
        self._last_rsi = _wilder_rsi(self._avg_gain, self._avg_loss)
        return self._last_rsi

    def _record_trace(
        self,
        frame: ObservationFrame,
        *,
        rsi: Decimal,
        direction: str | None,
        reason: str | None,
    ) -> None:
        if not self._debug_trace_enabled:
            return
        if len(self._debug_trace) >= self._TRACE_LIMIT:
            raise StrategyProviderError(
                "BUDGET_EXCEEDED", "Wilder RSI debug trace exceeds 10000 decisions"
            )
        self._debug_trace.append(
            {
                "sequence": frame.sequence,
                "eventTimeMs": frame.event_time_ms,
                "rsi": str(rsi),
                "signal": direction,
                "targetAfter": self._target_direction,
                "reasonCode": reason,
            }
        )


class BuiltinExpressionModelProvider:
    """Restricted local score expression for indicator/model-driven signals."""

    def __init__(self) -> None:
        self._source = "close - open"
        self._threshold = Decimal("0")
        self._long_target = Decimal("1")
        self._short_target = Decimal("-1")
        self._code: Any = None
        self._seen: list[int] = []

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("TARGET_POSITION",),
            reproducibility=("DETERMINISTIC",),
        )

    def identity(self) -> dict[str, Any]:
        return {
            "revision": BUILTIN_EXPRESSION_REVISION,
            "sourceHash": canonical_hash(self._source),
            "threshold": str(self._threshold),
            "longTarget": str(self._long_target),
            "shortTarget": str(self._short_target),
        }

    def prepare(self, context: dict[str, Any]) -> None:
        parameters = context.get("parameters") or {}
        source = str(context.get("source") or parameters.get("expression") or "close - open").strip()
        if not source or len(source) > 2_000:
            raise StrategyProviderError(
                "BUDGET_EXCEEDED", "model expression must contain 1..2000 characters"
            )
        try:
            threshold = Decimal(str(parameters.get("threshold", "0")))
            long_target = Decimal(str(parameters.get("long_target", "1")))
            short_target = Decimal(str(parameters.get("short_target", "-1")))
        except (TypeError, ValueError) as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "invalid expression model parameters"
            ) from exc
        if any(not value.is_finite() for value in (threshold, long_target, short_target)):
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "expression parameters must be finite"
            )
        self._source = source
        self._threshold = abs(threshold)
        self._long_target = long_target
        self._short_target = short_target
        self._code = _compile_expression(source)
        self._seen = []

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._score(frame)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        score = self._score(frame)
        if score > self._threshold:
            target, reason = self._long_target, "expression_positive"
        elif score < -self._threshold:
            target, reason = self._short_target, "expression_negative"
        else:
            target, reason = Decimal("0"), "expression_neutral"
        payload = {
            "targetExposure": str(target),
            "reasonCode": reason,
            "score": str(score),
        }
        return StrategyOutput(
            sequence=frame.sequence,
            kind="TARGET_POSITION",
            payload=payload,
            state_hash=canonical_hash(self._seen),
            output_hash=canonical_hash({"sequence": frame.sequence, "payload": payload}),
        )

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "execution report must declare accepted"
            )

    def snapshot(self) -> dict[str, Any]:
        return {
            "source": self._source,
            "threshold": str(self._threshold),
            "long_target": str(self._long_target),
            "short_target": str(self._short_target),
            "seen": list(self._seen),
        }

    def restore(self, payload: dict[str, Any]) -> None:
        self.prepare(
            {
                "source": payload["source"],
                "parameters": {
                    "threshold": payload["threshold"],
                    "long_target": payload["long_target"],
                    "short_target": payload["short_target"],
                },
            }
        )
        self._seen = [int(value) for value in payload.get("seen") or []]

    def close(self) -> str:
        return canonical_hash(self.snapshot())

    def _score(self, frame: ObservationFrame) -> Decimal:
        if self._code is None or frame.bar is None:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "prepared BAR input is required"
            )
        values: dict[str, float] = {}
        for name in _FEATURE_NAMES:
            raw = frame.features.get(name, frame.bar.get(name))
            if raw is not None:
                values[name] = float(raw)
        values.setdefault("price", values.get("close", 0.0))
        try:
            raw_score = eval(self._code, {"__builtins__": {}, **_PURE_FUNCTIONS}, values)
            score = Decimal(str(raw_score))
        except Exception as exc:
            raise StrategyProviderError(
                "PROVIDER_CRASH_UNRECOVERABLE", "expression model evaluation failed"
            ) from exc
        if not score.is_finite():
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "expression score must be finite"
            )
        self._seen.append(frame.sequence)
        return score


class BuiltinOrderCommandProvider:
    """Deterministic script adapter for explicit open/close/order commands."""

    def __init__(self) -> None:
        self._commands: dict[int, list[dict[str, object]]] = {}
        self._source_hash = canonical_hash({"commands": []})
        self._seen: list[int] = []

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE", "AGG_TRADE"),
            output_modes=("ORDER_INTENT",),
            reproducibility=("DETERMINISTIC",),
        )

    def identity(self) -> dict[str, Any]:
        return {"revision": BUILTIN_ORDER_COMMAND_REVISION, "sourceHash": self._source_hash}

    def prepare(self, context: dict[str, Any]) -> None:
        source = str(context.get("source") or '{"commands": []}').strip()
        try:
            payload = json.loads(source)
        except json.JSONDecodeError as exc:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "command script must be valid JSON"
            ) from exc
        commands = payload.get("commands") if isinstance(payload, dict) else None
        if not isinstance(commands, list) or len(commands) > 10_000:
            raise StrategyProviderError(
                "BUDGET_EXCEEDED", "command script requires at most 10000 commands"
            )
        scheduled: dict[int, list[dict[str, object]]] = {}
        for index, command in enumerate(commands):
            if not isinstance(command, dict):
                raise StrategyProviderError(
                    "PROVIDER_PROTOCOL_VIOLATION", f"command {index} must be an object"
                )
            try:
                sequence = int(command["sequence"])
                qty = Decimal(str(command.get("qty", "1")))
            except (KeyError, TypeError, ValueError) as exc:
                raise StrategyProviderError(
                    "PROVIDER_PROTOCOL_VIOLATION",
                    f"command {index} has invalid sequence or qty",
                ) from exc
            action = str(command.get("action") or "").upper()
            side_by_action = {
                "OPEN_LONG": "BUY",
                "CLOSE_LONG": "SELL",
                "OPEN_SHORT": "SELL",
                "CLOSE_SHORT": "BUY",
            }
            side = str(command.get("side") or side_by_action.get(action) or "").upper()
            order_type = str(command.get("type") or "MARKET").upper()
            if sequence < 1 or qty <= 0 or side not in {"BUY", "SELL"}:
                raise StrategyProviderError(
                    "PROVIDER_PROTOCOL_VIOLATION", f"command {index} is invalid"
                )
            intent: dict[str, object] = {
                "side": side,
                "type": order_type,
                "qty": str(qty),
                "reduce_only": action.startswith("CLOSE_"),
                "reason": str(command.get("reason") or action or "script_command"),
            }
            for name in ("limit_price", "stop_price", "oco_group"):
                if command.get(name) is not None:
                    intent[name] = command[name]
            scheduled.setdefault(sequence, []).append(intent)
        self._commands = scheduled
        self._source_hash = canonical_hash(payload)
        self._seen = []

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._seen.append(frame.sequence)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._seen.append(frame.sequence)
        intents = self._commands.get(frame.sequence)
        if not intents:
            return None
        payload = {"intents": [dict(item) for item in intents]}
        return StrategyOutput(
            sequence=frame.sequence,
            kind="ORDER_INTENT",
            payload=payload,
            state_hash=canonical_hash(self._seen),
            output_hash=canonical_hash(
                {"sequence": frame.sequence, "kind": "ORDER_INTENT", "payload": payload}
            ),
        )

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "execution report must declare accepted"
            )

    def snapshot(self) -> dict[str, Any]:
        return {"seen": list(self._seen), "source_hash": self._source_hash}

    def restore(self, payload: dict[str, Any]) -> None:
        self._seen = [int(value) for value in payload.get("seen") or []]
        self._source_hash = str(payload.get("source_hash") or self._source_hash)

    def close(self) -> str:
        return canonical_hash(self.snapshot())


def build_builtin_provider(strategy_revision_id: str) -> StrategyProvider:
    factories = {
        BUILTIN_SMA_REVISION: BuiltinSmaCrossProvider,
        BUILTIN_RSI_REVISION: BuiltinRsiReversionProvider,
        BUILTIN_RSI_WILDER_LONG_SHORT_REVISION: BuiltinRsiWilderLongShortProvider,
        BUILTIN_EXPRESSION_REVISION: BuiltinExpressionModelProvider,
        BUILTIN_ORDER_COMMAND_REVISION: BuiltinOrderCommandProvider,
    }
    try:
        return factories[strategy_revision_id]()
    except KeyError as exc:
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION",
            f"unknown standalone strategy revision {strategy_revision_id}",
        ) from exc


def _mean(values: list[Decimal]) -> Decimal:
    return sum(values, Decimal("0")) / Decimal(len(values))


def _optional_decimal_value(value: object) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _wilder_rsi(avg_gain: Decimal, avg_loss: Decimal) -> Decimal:
    if avg_gain == 0 and avg_loss == 0:
        return Decimal("50")
    if avg_loss == 0:
        return Decimal("100")
    if avg_gain == 0:
        return Decimal("0")
    relative_strength = avg_gain / avg_loss
    return Decimal("100") - Decimal("100") / (Decimal("1") + relative_strength)


def _compile_expression(source: str) -> Any:
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION", "model expression is invalid"
        ) from exc
    nodes = list(ast.walk(tree))
    if len(nodes) > 128:
        raise StrategyProviderError("BUDGET_EXCEEDED", "model expression is too complex")
    allowed_names = set(_FEATURE_NAMES) | set(_PURE_FUNCTIONS)
    for node in nodes:
        if not isinstance(node, _EXPRESSION_NODES):
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                f"model expression does not allow {type(node).__name__}",
            )
        if isinstance(node, ast.Name) and node.id not in allowed_names:
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                f"model expression cannot access {node.id}",
            )
        if isinstance(node, ast.Call) and (
            not isinstance(node.func, ast.Name) or node.func.id not in _PURE_FUNCTIONS
        ):
            raise StrategyProviderError(
                "PROVIDER_UNAUTHORIZED_WRITE",
                "model expression may call only approved pure functions",
            )
    return compile(tree, "<backtest-expression>", "eval")
