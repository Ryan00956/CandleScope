"""Explainable, fail-closed fast-forward planning for replay training runs."""

from __future__ import annotations

from dataclasses import dataclass

from app.replay.canonical import canonical_sha256

from .models import FastForwardPlan, ReplaySource


FAST_FORWARD_PLAN_SCHEMA_VERSION = "replay.fast-forward.plan.v1"
FAST_FORWARD_EQUIVALENCE_VERSION = "replay.fast-forward.equivalence.v1"


@dataclass(frozen=True, slots=True)
class FastForwardContext:
    """All server-authoritative facts used to choose one execution plan."""

    source_kind: ReplaySource
    current_virtual_time_ms: int
    target_virtual_time_ms: int
    dataset_epoch: str
    optimization_enabled: bool
    path_dependencies: tuple[str, ...] = ()
    blocking_reasons: tuple[str, ...] = ()
    checkpoint_identity_match: bool = False
    checkpoint_state_hash: str | None = None
    estimated_events: int | None = None
    max_events: int | None = None
    chunk_event_limit: int = 32
    tail_event_count: int = 0
    track_count: int = 1

    def __post_init__(self) -> None:
        source = (
            self.source_kind
            if isinstance(self.source_kind, ReplaySource)
            else ReplaySource(self.source_kind)
        )
        object.__setattr__(self, "source_kind", source)
        for field_name in ("current_virtual_time_ms", "target_virtual_time_ms"):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")
        if not isinstance(self.dataset_epoch, str) or not self.dataset_epoch.strip():
            raise ValueError("dataset_epoch cannot be blank")
        if not isinstance(self.optimization_enabled, bool):
            raise TypeError("optimization_enabled must be a boolean")
        for field_name in ("path_dependencies", "blocking_reasons"):
            values = tuple(sorted(set(getattr(self, field_name))))
            if any(not isinstance(value, str) or not value for value in values):
                raise ValueError(f"{field_name} must contain non-empty strings")
            object.__setattr__(self, field_name, values)
        if not isinstance(self.checkpoint_identity_match, bool):
            raise TypeError("checkpoint_identity_match must be a boolean")
        for field_name in ("estimated_events", "max_events"):
            value = getattr(self, field_name)
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0
            ):
                raise ValueError(f"{field_name} must be a non-negative integer or null")
        for field_name in ("chunk_event_limit", "track_count"):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{field_name} must be a positive integer")
        if (
            isinstance(self.tail_event_count, bool)
            or not isinstance(self.tail_event_count, int)
            or self.tail_event_count < 0
            or self.tail_event_count > self.chunk_event_limit
        ):
            raise ValueError("tail_event_count must fit inside chunk_event_limit")

    def proof_material(self) -> dict[str, object]:
        return {
            "schema_version": FAST_FORWARD_EQUIVALENCE_VERSION,
            "source_kind": self.source_kind.value,
            "dataset_epoch": self.dataset_epoch,
            "current_virtual_time_ms": self.current_virtual_time_ms,
            "target_virtual_time_ms": self.target_virtual_time_ms,
            "path_dependencies": list(self.path_dependencies),
            "track_count": self.track_count,
        }


@dataclass(frozen=True, slots=True)
class FastForwardDecision:
    plan: FastForwardPlan
    reason_codes: tuple[str, ...]
    explanation: str
    context: FastForwardContext

    def to_dict(self) -> dict[str, object]:
        optimized = self.plan in {
            FastForwardPlan.CHECKPOINT_JUMP,
            FastForwardPlan.AGGREGATE_SCAN,
        }
        proof_material = self.context.proof_material()
        proof_material["selected_plan"] = self.plan.value
        return {
            "schema_version": FAST_FORWARD_PLAN_SCHEMA_VERSION,
            # ``mode`` is retained for the Phase 3 response shape while ``plan``
            # is the explicit Phase 8 contract name.
            "mode": self.plan.value,
            "plan": self.plan.value,
            "source_kind": self.context.source_kind.value,
            "current_virtual_time_ms": self.context.current_virtual_time_ms,
            "target_virtual_time_ms": self.context.target_virtual_time_ms,
            "reason_codes": list(self.reason_codes),
            "explanation": self.explanation,
            "optimized": optimized,
            "cancelable": self.plan is not FastForwardPlan.BLOCKED,
            "chunk_event_limit": self.context.chunk_event_limit,
            "tail_event_count": self.context.tail_event_count,
            "estimated_events": self.context.estimated_events,
            "streaming": {
                "page_bounded": True,
                "resident_pages": 1,
                "prefetch_pages": 1,
                "backpressure": "ACTOR_ACK_BOUNDARY",
                "full_history_materialization": False,
            },
            "equivalence": {
                "schema_version": FAST_FORWARD_EQUIVALENCE_VERSION,
                "reference_plan": FastForwardPlan.FULL_EVENT_SCAN.value,
                "proof": "CURSOR_SOURCE_EVENT_CHAIN_COMPONENT_STATE_HASH",
                "status": "REQUIRED" if optimized else "REFERENCE_PATH",
                "contract_digest": canonical_sha256(proof_material),
                "dataset_epoch": self.context.dataset_epoch,
                "checkpoint_state_hash": self.context.checkpoint_state_hash,
            },
        }


class FastForwardPlanner:
    """Choose the fastest plan whose correctness can be explained in advance."""

    def plan(self, context: FastForwardContext) -> FastForwardDecision:
        if not isinstance(context, FastForwardContext):
            raise TypeError("context must be FastForwardContext")
        if context.target_virtual_time_ms <= context.current_virtual_time_ms:
            return self._decision(
                FastForwardPlan.BLOCKED,
                ("TARGET_NOT_AHEAD",),
                "目标虚拟时刻必须晚于当前游标。",
                context,
            )
        resource_exceeded = (
            context.estimated_events is not None
            and context.max_events is not None
            and context.estimated_events > context.max_events
        )
        blocking = list(context.blocking_reasons)
        if resource_exceeded:
            blocking.append("RESOURCE_BUDGET_EXCEEDED")
        if blocking:
            return self._decision(
                FastForwardPlan.BLOCKED,
                tuple(sorted(set(blocking))),
                "数据连续性、身份或资源预算不足，无法证明安全推进。",
                context,
            )
        if context.path_dependencies:
            return self._decision(
                FastForwardPlan.FULL_EVENT_SCAN,
                context.path_dependencies,
                "存在订单、持仓、资金费、风险或多轨路径依赖；逐事件顺序推进。",
                context,
            )
        if not context.optimization_enabled:
            return self._decision(
                FastForwardPlan.FULL_EVENT_SCAN,
                ("OPTIMIZATION_DISABLED",),
                "优化开关关闭；使用已验证的逐事件参考路径。",
                context,
            )
        if context.checkpoint_identity_match:
            if context.checkpoint_state_hash is None:
                return self._decision(
                    FastForwardPlan.BLOCKED,
                    ("CHECKPOINT_PROOF_MISSING",),
                    "目标 checkpoint 缺少可验证状态哈希。",
                    context,
                )
            return self._decision(
                FastForwardPlan.CHECKPOINT_JUMP,
                ("EXACT_CHECKPOINT_IDENTITY",),
                "目标 checkpoint 的数据身份和依赖状态完全一致；恢复后精确处理尾部。",
                context,
            )
        if context.source_kind in {ReplaySource.AGG_TRADE, ReplaySource.BAR}:
            return self._decision(
                FastForwardPlan.AGGREGATE_SCAN,
                ("NO_PATH_DEPENDENCIES", "EXACT_REDUCER_SCAN"),
                "无账户路径依赖；按有界页精确扫描并合并中间投影，尾部事件仍逐笔发布。",
                context,
            )
        return self._decision(
            FastForwardPlan.BLOCKED,
            ("SOURCE_MODE_UNSUPPORTED",),
            "当前数据源没有经过证明的快进执行路径。",
            context,
        )

    @staticmethod
    def _decision(
        plan: FastForwardPlan,
        reasons: tuple[str, ...],
        explanation: str,
        context: FastForwardContext,
    ) -> FastForwardDecision:
        return FastForwardDecision(
            plan=plan,
            reason_codes=tuple(sorted(set(reasons))),
            explanation=explanation,
            context=context,
        )


__all__ = [
    "FAST_FORWARD_EQUIVALENCE_VERSION",
    "FAST_FORWARD_PLAN_SCHEMA_VERSION",
    "FastForwardContext",
    "FastForwardDecision",
    "FastForwardPlanner",
]
