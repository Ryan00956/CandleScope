"""Capability projection for strategy research sources.

Absence is unavailable. Callers must not treat a missing key as true.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

from .contracts import SOURCE_KINDS, QualitySummary, ResearchSourceRef, SourceKind

CAPABILITY_IDS = (
    "viewKlines",
    "importNewData",
    "modifyRevisionPointer",
    "barApprox",
    "tradeTape",
    "onlineBackfill",
    "indicators",
    "drawingsEvents",
)

CapabilityId = Literal[
    "viewKlines",
    "importNewData",
    "modifyRevisionPointer",
    "barApprox",
    "tradeTape",
    "onlineBackfill",
    "indicators",
    "drawingsEvents",
]

RuntimeMode = Literal["LIVE", "LOCAL_OFFLINE"]


@dataclass(frozen=True, slots=True)
class CapabilityDecision:
    available: bool
    reason_code: str | None
    user_reason: str
    user_action: str

    def wire(self) -> dict[str, object]:
        return {
            "available": self.available,
            "reasonCode": self.reason_code,
            "userReason": self.user_reason,
            "userAction": self.user_action,
        }


@dataclass(frozen=True, slots=True)
class CapabilitySummary:
    source_kind: SourceKind
    runtime_mode: RuntimeMode
    fidelity_ceiling: str
    capabilities: dict[str, CapabilityDecision]

    def wire(self) -> dict[str, object]:
        return {
            "sourceKind": self.source_kind,
            "runtimeMode": self.runtime_mode,
            "fidelityCeiling": self.fidelity_ceiling,
            "capabilities": {
                key: decision.wire() for key, decision in self.capabilities.items()
            },
        }


def _allow(reason: str) -> CapabilityDecision:
    return CapabilityDecision(True, None, reason, "")


def _deny(code: str, reason: str, action: str) -> CapabilityDecision:
    return CapabilityDecision(False, code, reason, action)


def _source_kind(source: ResearchSourceRef | SourceKind) -> SourceKind:
    if isinstance(source, str):
        if source not in SOURCE_KINDS:
            raise ValueError(f"unknown source kind {source!r}")
        return source
    return source.kind


def is_capability_available(summary: Mapping[str, Any] | CapabilitySummary, capability_id: str) -> bool:
    """Fail closed: missing capability is unavailable, never guessed true."""
    if isinstance(summary, CapabilitySummary):
        decision = summary.capabilities.get(capability_id)
        return bool(decision is not None and decision.available)
    capabilities = summary.get("capabilities") if isinstance(summary, Mapping) else None
    if not isinstance(capabilities, Mapping):
        return False
    decision = capabilities.get(capability_id)
    if not isinstance(decision, Mapping):
        return False
    return decision.get("available") is True


def project_capabilities(
    source: ResearchSourceRef | SourceKind,
    *,
    quality: QualitySummary | None = None,
    runtime_mode: RuntimeMode = "LIVE",
    has_frozen_trades: bool = False,
    has_result_capabilities: bool | None = None,
) -> CapabilitySummary:
    kind = _source_kind(source)
    quality_ok = quality is not None and quality.status == "ok"
    imported = kind == "IMPORTED_DATASET"
    completed = kind == "COMPLETED_RUN"
    chart = kind == "CURRENT_CHART"
    offline = runtime_mode == "LOCAL_OFFLINE"

    _ = has_result_capabilities  # reserved; missing result receipts stay BAR_APPROX
    fidelity = "TRADE_TAPE" if has_frozen_trades else "BAR_APPROX"

    bar_reason_ok = "基于 K 线估算"
    decisions: dict[str, CapabilityDecision] = {
        "viewKlines": _allow("可以查看 K 线"),
        "importNewData": (
            _allow("可以导入 CSV")
            if imported
            else _deny("IMPORT_NOT_AVAILABLE", "当前来源不能导入新数据", "切换到本地资料库")
        ),
        "modifyRevisionPointer": (
            _allow("可以激活数据版本")
            if imported
            else _deny("REVISION_POINTER_NOT_AVAILABLE", "当前来源不能修改数据版本", "在本地资料库中管理数据版本")
        ),
        "barApprox": (
            _allow(bar_reason_ok)
            if (imported or completed or quality_ok)
            else _deny("DATA_GAP", "所选区间存在缺口", "缩短区间或导入完整数据")
        ),
        "tradeTape": (
            _allow("已有冻结成交")
            if has_frozen_trades
            else _deny(
                "UNSUPPORTED_FIDELITY",
                "当前数据不支持逐笔精度，只能基于 K 线估算",
                "使用 K 线估算或导入成交数据",
            )
        ),
        "onlineBackfill": (
            _deny("OFFLINE_LIVE_SOURCE_UNAVAILABLE", "离线运行时没有实时行情", "选择本地资料库")
            if offline
            else _allow("用户确认后可准备缺失历史")
            if chart
            else _deny("IMPORTED_DATASET_NEVER_NETWORKS", "导入数据不会联网补历史", "使用已导入的数据或缩短区间")
        ),
        "indicators": (
            _allow("只读结果能力")
            if completed
            else _allow("本地显式-bars 指标")
            if imported
            else _allow("当前行情指标")
            if not offline
            else _deny("OFFLINE_LIVE_SOURCE_UNAVAILABLE", "离线运行时没有实时行情指标", "选择本地资料库")
        ),
        "drawingsEvents": (
            _allow("独立复核范围")
            if completed
            else _allow("绑定当前数据版本")
            if imported
            else _allow("绑定当前图表")
        ),
    }

    if offline and chart:
        decisions["viewKlines"] = _deny(
            "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
            "离线运行时没有实时行情",
            "选择本地资料库",
        )
        decisions["barApprox"] = _deny(
            "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
            "离线运行时不能运行当前图表策略",
            "选择本地资料库",
        )

    return CapabilitySummary(
        source_kind=kind,
        runtime_mode=runtime_mode,
        fidelity_ceiling=fidelity,
        capabilities=decisions,
    )
