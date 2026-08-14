"""Immutable runtime registry for executable strategy revisions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.backtest.strategy.builtin import (
    BUILTIN_EXPRESSION_REVISION,
    BUILTIN_ORDER_COMMAND_REVISION,
    BUILTIN_RSI_REVISION,
    BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
    BUILTIN_SMA_REVISION,
    BuiltinExpressionModelProvider,
    BuiltinOrderCommandProvider,
    BuiltinRsiReversionProvider,
    BuiltinRsiWilderLongShortProvider,
    BuiltinSmaCrossProvider,
)
from app.backtest.strategy.protocol import StrategyProvider, StrategyProviderError


@dataclass(frozen=True, slots=True)
class StrategyRevisionDescriptor:
    revision_id: str
    provider_kind: str
    factory: Callable[[], StrategyProvider]
    label: str = ""
    description: str = ""
    parameter_schema: tuple[dict[str, object], ...] = ()
    accepts_source: bool = False

    def to_wire(self) -> dict[str, object]:
        capabilities = self.factory().describe()
        return {
            "revision_id": self.revision_id,
            "provider_kind": self.provider_kind,
            "label": self.label or self.revision_id,
            "description": self.description,
            "input_modes": list(capabilities.input_modes),
            "output_modes": list(capabilities.output_modes),
            "signal_clock": capabilities.signal_clock,
            "required_features": list(capabilities.required_features),
            "warmup_requirement": dict(capabilities.warmup_requirement),
            "parameter_schema": [dict(item) for item in self.parameter_schema],
            "accepts_source": self.accepts_source,
        }


class StrategyRevisionRegistry:
    def __init__(self) -> None:
        self._descriptors: dict[str, StrategyRevisionDescriptor] = {}

    def register(self, descriptor: StrategyRevisionDescriptor) -> None:
        if descriptor.revision_id in self._descriptors:
            raise StrategyProviderError(
                "IDENTITY_MUTATION",
                f"strategy revision {descriptor.revision_id} is immutable",
            )
        self._descriptors[descriptor.revision_id] = descriptor

    def require(self, revision_id: str) -> StrategyRevisionDescriptor:
        try:
            return self._descriptors[revision_id]
        except KeyError as exc:
            raise StrategyProviderError(
                "SCHEMA_UNKNOWN_FIELD",
                f"unknown strategy revision {revision_id}",
            ) from exc

    def build(self, revision_id: str) -> StrategyProvider:
        return self.require(revision_id).factory()

    def revision_ids(self) -> list[str]:
        return sorted(self._descriptors)

    def descriptors(self) -> list[dict[str, object]]:
        return [self._descriptors[key].to_wire() for key in sorted(self._descriptors)]


def build_default_strategy_registry() -> StrategyRevisionRegistry:
    registry = StrategyRevisionRegistry()
    registry.register(
        StrategyRevisionDescriptor(
            revision_id=BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
            provider_kind="INDICATOR",
            factory=BuiltinRsiWilderLongShortProvider,
            label="Wilder RSI 多空",
            description="完结 BAR close 的 Wilder RSI；超卖做多、超买反手做空。",
            parameter_schema=(
                {"name": "length", "label": "RSI 长度", "type": "integer", "default": 24, "minimum": 2, "maximum": 5000},
                {"name": "oversold", "label": "超卖", "type": "number", "default": 30, "exclusiveMinimum": 0, "exclusiveMaximumParameter": "overbought"},
                {"name": "overbought", "label": "超买", "type": "number", "default": 70, "exclusiveMinimumParameter": "oversold", "exclusiveMaximum": 100},
                {"name": "trigger_mode", "label": "触发模式", "type": "enum", "default": "LEVEL_TARGET_V1", "options": ["LEVEL_TARGET_V1"]},
                {"name": "debug_trace", "label": "决策 Debug Trace", "type": "boolean", "default": False},
            ),
        )
    )
    registry.register(
        StrategyRevisionDescriptor(
            revision_id=BUILTIN_SMA_REVISION,
            provider_kind="BUILTIN",
            factory=BuiltinSmaCrossProvider,
            label="SMA 交叉",
            description="BAR 收盘快慢均线交叉，输出目标仓位。",
            parameter_schema=(
                {"name": "fast", "label": "Fast SMA", "type": "integer", "default": 3},
                {"name": "slow", "label": "Slow SMA", "type": "integer", "default": 5},
            ),
        )
    )
    registry.register(
        StrategyRevisionDescriptor(
            revision_id=BUILTIN_RSI_REVISION,
            provider_kind="INDICATOR",
            factory=BuiltinRsiReversionProvider,
            label="RSI 均值回归",
            description="BAR 收盘 RSI 超卖开多、超买平仓。",
            parameter_schema=(
                {"name": "length", "label": "RSI Length", "type": "integer", "default": 14},
                {"name": "oversold", "label": "超卖", "type": "number", "default": 30},
                {"name": "overbought", "label": "超买", "type": "number", "default": 70},
            ),
        )
    )
    registry.register(
        StrategyRevisionDescriptor(
            revision_id=BUILTIN_EXPRESSION_REVISION,
            provider_kind="MODEL",
            factory=BuiltinExpressionModelProvider,
            label="本地表达式模型",
            description="安全、无网络的 OHLCV 评分表达式；正分做多、负分做空。",
            parameter_schema=(
                {"name": "threshold", "label": "中性阈值", "type": "number", "default": 0},
                {"name": "long_target", "label": "多头目标", "type": "number", "default": 1},
                {"name": "short_target", "label": "空头目标", "type": "number", "default": -1},
            ),
            accepts_source=True,
        )
    )
    registry.register(
        StrategyRevisionDescriptor(
            revision_id=BUILTIN_ORDER_COMMAND_REVISION,
            provider_kind="SCRIPT",
            factory=BuiltinOrderCommandProvider,
            label="统一订单命令脚本",
            description="按事件序号发出开多、平多、开空、平空或原始订单意图。",
            parameter_schema=(),
            accepts_source=True,
        )
    )
    return registry
