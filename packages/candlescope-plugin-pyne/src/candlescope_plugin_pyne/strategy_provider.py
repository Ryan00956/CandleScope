"""Isolated Pyne strategy-provider/1 adapter. Does not change script-runtime/1."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from candlescope_plugin_sdk.strategy_provider_v1.models import (
    CONTRIBUTION_KIND,
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
)
from candlescope_plugin_sdk.strategy_provider_v1.session import (
    StrategyProviderError,
    canonical_hash,
)

EXPECTED_PYNE_VERSION = "0.3.0rc2"
PLUGIN_VERSION = "0.3.0.dev0"
RUNTIME_ID = "candlescope.pyne"

ADAPTER_VERSION = "candlescope.pyne-strategy/1"
SMA_CROSS_MARKER = "candlescope.strategy-example:sma_cross"
SMA_CROSS_SOURCE = """// candlescope.strategy-example:sma_cross
// Frozen BAR-close example. Host maps the last signal to TARGET_POSITION.
indicator("SMA Cross Strategy", overlay=true)
fast_len = input.int(3, "fast")
slow_len = input.int(5, "slow")
fast = ta.sma(close, fast_len)
slow = ta.sma(close, slow_len)
long_signal = ta.crossover(fast, slow)
flat_signal = ta.crossunder(fast, slow)
"""

Executor = Callable[[str, list[dict[str, Any]], dict[str, Any], dict[str, Any]], Mapping[str, Any]]


def source_hash(source: str) -> str:
    return "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()


def _json_hash(value: object) -> str:
    return canonical_hash(value)


@dataclass(frozen=True, slots=True)
class _Bar:
    time: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


class PyneStrategyProvider:
    """Bar-close Pyne provider. Never writes Host orders or opens live sockets."""

    def __init__(self, *, executor: Executor | None = None) -> None:
        self._executor = executor
        self._source = ""
        self._params: dict[str, Any] = {}
        self._seed: int | None = None
        self._output_mode = "TARGET_POSITION"
        self._bars: list[_Bar] = []
        self._prepared = False
        self._identity: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL", "TARGET_POSITION"),
            state_modes=("SESSION_STATEFUL",),
            reproducibility=("DETERMINISTIC", "SEEDED"),
            snapshot_restore=True,
        )

    def identity(self) -> dict[str, Any]:
        return dict(self._identity)

    def prepare(self, context: dict[str, Any]) -> None:
        source = str(context.get("source") or "").strip()
        if not source:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "Pyne source is required")
        params = context.get("parameters") or {}
        if not isinstance(params, Mapping):
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "parameters must be an object")
        seed = context.get("seed")
        if seed is not None:
            try:
                seed = int(seed)
            except (TypeError, ValueError) as exc:
                raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "seed must be an integer") from exc
        output_mode = str(context.get("outputMode") or "TARGET_POSITION")
        if output_mode not in {"SIGNAL", "TARGET_POSITION"}:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "unsupported outputMode")
        self._source = source
        self._params = dict(params)
        self._seed = seed
        self._output_mode = output_mode
        self._bars = []
        self._prepared = True
        self._identity = {
            "adapterVersion": ADAPTER_VERSION,
            "contributionKind": CONTRIBUTION_KIND,
            "runtimeId": RUNTIME_ID,
            "pluginVersion": PLUGIN_VERSION,
            "engine": "pyne-runtime",
            "expectedEngineVersion": EXPECTED_PYNE_VERSION,
            "sourceHash": source_hash(source),
            "parametersHash": _json_hash(self._params),
            "seed": seed,
            "outputMode": output_mode,
        }

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._append(frame)
        self._evaluate(frame.sequence, emit=False)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._append(frame)
        return self._evaluate(frame.sequence, emit=True)

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "report missing accepted")

    def snapshot(self) -> dict[str, Any]:
        return {
            "source": self._source,
            "parameters": dict(self._params),
            "seed": self._seed,
            "outputMode": self._output_mode,
            "bars": [self._bar_wire(bar) for bar in self._bars],
            "identity": dict(self._identity),
        }

    def restore(self, payload: dict[str, Any]) -> None:
        self.prepare(
            {
                "source": payload["source"],
                "parameters": payload.get("parameters") or {},
                "seed": payload.get("seed"),
                "outputMode": payload.get("outputMode") or "TARGET_POSITION",
            }
        )
        self._bars = [_bar_from_wire(item) for item in payload.get("bars") or []]

    def close(self) -> str:
        return _json_hash(
            {
                "identity": self._identity,
                "bars": [self._bar_wire(bar) for bar in self._bars],
            }
        )

    def _append(self, frame: ObservationFrame) -> None:
        if not self._prepared:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "prepare first")
        if frame.bar is None:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "BAR_CLOSE requires a bar")
        if frame.event_time_ms > frame.watermark_ms:
            raise StrategyProviderError("LOOKAHEAD_VIOLATION", "bar after watermark")
        bar = _bar_from_observation(frame.bar, frame.event_time_ms)
        if self._bars and bar.time <= self._bars[-1].time:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "bars must move forward")
        self._bars.append(bar)

    def _evaluate(self, sequence: int, *, emit: bool) -> StrategyOutput | None:
        raw = self._run_engine()
        mapped = map_pyne_strategy_output(raw, output_mode=self._output_mode)
        if mapped is None:
            mapped = evaluate_sma_cross(self._bars, self._params) if _is_sma_example(self._source) else None
        if mapped is None or not emit:
            return None
        payload, kind = mapped
        return StrategyOutput(
            sequence=sequence,
            kind=kind,
            payload=payload,
            state_hash=_json_hash([self._bar_wire(bar) for bar in self._bars]),
            output_hash=_json_hash({"sequence": sequence, "kind": kind, "payload": payload}),
        )

    def _run_engine(self) -> Mapping[str, Any] | None:
        bars = [self._bar_engine(bar) for bar in self._bars]
        options = {"securityMode": "safe", "seed": self._seed}
        if self._executor is not None:
            return self._executor(self._source, bars, self._params, options)
        try:
            import pyne_runtime
        except ImportError:
            return None
        settings_type = getattr(pyne_runtime, "PyneSettings", None)
        execute = getattr(pyne_runtime, "execute_pyne_script", None)
        if settings_type is None or execute is None:
            return None
        result = execute(
            script=self._source,
            ohlcv=bars,
            params=dict(self._params),
            settings=settings_type.from_env(),
            executor_mode="inline",
        )
        output = getattr(result, "output", None)
        return output if isinstance(output, Mapping) else None

    @staticmethod
    def _bar_wire(bar: _Bar) -> dict[str, Any]:
        return {
            "time": bar.time,
            "open": str(bar.open),
            "high": str(bar.high),
            "low": str(bar.low),
            "close": str(bar.close),
            "volume": str(bar.volume),
        }

    @staticmethod
    def _bar_engine(bar: _Bar) -> dict[str, Any]:
        return {
            "time": bar.time,
            "open": float(bar.open),
            "high": float(bar.high),
            "low": float(bar.low),
            "close": float(bar.close),
            "volume": float(bar.volume),
        }


def _is_sma_example(source: str) -> bool:
    return SMA_CROSS_MARKER in source or source.strip() == SMA_CROSS_SOURCE.strip()


def evaluate_sma_cross(
    bars: Sequence[_Bar],
    params: Mapping[str, Any],
) -> tuple[dict[str, str], str] | None:
    fast_len = int(params.get("fast") or params.get("fast_len") or 3)
    slow_len = int(params.get("slow") or params.get("slow_len") or 5)
    if fast_len < 1 or slow_len < 1 or fast_len >= slow_len:
        raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "invalid SMA lengths")
    if len(bars) < slow_len + 1:
        return None
    closes = [bar.close for bar in bars]
    fast_now = sum(closes[-fast_len:]) / fast_len
    slow_now = sum(closes[-slow_len:]) / slow_len
    fast_prev = sum(closes[-fast_len - 1 : -1]) / fast_len
    slow_prev = sum(closes[-slow_len - 1 : -1]) / slow_len
    crossed_up = fast_prev <= slow_prev and fast_now > slow_now
    crossed_down = fast_prev >= slow_prev and fast_now < slow_now
    if crossed_up:
        return {"targetExposure": "1", "reasonCode": "sma_cross_up"}, "TARGET_POSITION"
    if crossed_down:
        return {"targetExposure": "0", "reasonCode": "sma_cross_down"}, "TARGET_POSITION"
    return None


def map_pyne_strategy_output(
    output: Mapping[str, Any] | None,
    *,
    output_mode: str,
) -> tuple[dict[str, str], str] | None:
    if not output:
        return None
    strategy = output.get("strategy")
    if isinstance(strategy, Mapping):
        position = strategy.get("position")
        if position is None:
            position = strategy.get("marketPosition")
        if position is not None:
            exposure = _exposure(position)
            if output_mode == "SIGNAL":
                direction = "LONG" if Decimal(exposure) > 0 else "FLAT"
                return {"direction": direction, "reasonCode": "pyne_strategy"}, "SIGNAL"
            return {"targetExposure": exposure, "reasonCode": "pyne_strategy"}, "TARGET_POSITION"
    signals = output.get("signals")
    if isinstance(signals, Sequence) and signals:
        last = signals[-1]
        if isinstance(last, Mapping):
            direction = str(last.get("direction") or last.get("side") or "").upper()
            if direction in {"LONG", "BUY"}:
                payload = {"direction": "LONG", "reasonCode": "pyne_signal"}
                if output_mode == "TARGET_POSITION":
                    return {"targetExposure": "1", "reasonCode": "pyne_signal"}, "TARGET_POSITION"
                return payload, "SIGNAL"
            if direction in {"SHORT", "SELL", "FLAT"}:
                payload = {"direction": "FLAT", "reasonCode": "pyne_signal"}
                if output_mode == "TARGET_POSITION":
                    return {"targetExposure": "0", "reasonCode": "pyne_signal"}, "TARGET_POSITION"
                return payload, "SIGNAL"
    return None


def _bar_from_observation(bar: Mapping[str, Any], fallback_time_ms: int) -> _Bar:
    raw_time = bar.get("time", bar.get("open_time_ms", fallback_time_ms))
    time_value = int(raw_time)
    if time_value > 10_000_000_000:
        time_value //= 1000
    return _Bar(
        time=time_value,
        open=Decimal(str(bar["open"])),
        high=Decimal(str(bar["high"])),
        low=Decimal(str(bar["low"])),
        close=Decimal(str(bar["close"])),
        volume=Decimal(str(bar.get("volume") or "0")),
    )


def _bar_from_wire(value: Mapping[str, Any]) -> _Bar:
    return _Bar(
        time=int(value["time"]),
        open=Decimal(str(value["open"])),
        high=Decimal(str(value["high"])),
        low=Decimal(str(value["low"])),
        close=Decimal(str(value["close"])),
        volume=Decimal(str(value["volume"])),
    )


def _exposure(position: object) -> str:
    text = str(position).strip().lower()
    if text in {"long", "buy", "1"}:
        return "1"
    if text in {"flat", "short", "sell", "0"}:
        return "0"
    return str(Decimal(str(position)))



