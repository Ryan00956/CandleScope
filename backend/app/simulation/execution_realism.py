"""Frozen execution-realism V2 identity and fail-closed configuration."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Mapping

from app.market_dataset.snapshot import MarketDatasetError

EXECUTION_REALISM_V2 = "EXECUTION_REALISM_V2"
BAR_FILL_POLICY_V2 = "BAR_VOLUME_PARTICIPATION_WORST_CASE_V2"
BAR_PATH_SCENARIO = "OHLC_WORST_CASE_STOP_FIRST_V1"
TRADE_FILL_POLICY_V2 = "AGG_TRADE_LATENCY_PARTICIPATION_V2"
END_POLICIES = frozenset({"KEEP_OPEN", "CANCEL_AT_END"})


@dataclass(frozen=True, slots=True)
class ExecutionRealismConfig:
    revision: str | None = None
    participation_rate: Decimal | None = None
    latency_ms: int = 0
    latency_events: int = 0
    end_policy: str = "CANCEL_AT_END"
    bar_path_scenario: str | None = None

    @property
    def enabled(self) -> bool:
        return self.revision == EXECUTION_REALISM_V2

    def identity(self, *, fidelity_mode: str) -> dict[str, object]:
        if not self.enabled:
            return {}
        payload: dict[str, object] = {
            "execution_model_revision": EXECUTION_REALISM_V2,
            "participation_rate": str(self.participation_rate),
            "order_end_policy": self.end_policy,
            "tif_supported": ["GTC", "IOC"],
            "equity_curve_event_interval": 100,
        }
        if fidelity_mode == "BAR_APPROX":
            payload.update(
                {
                    "fill_policy": BAR_FILL_POLICY_V2,
                    "bar_path_scenario": BAR_PATH_SCENARIO,
                }
            )
        else:
            payload.update(
                {
                    "fill_policy": TRADE_FILL_POLICY_V2,
                    "latency_ms": self.latency_ms,
                    "latency_events": self.latency_events,
                }
            )
        return payload


def parse_execution_realism(
    payload: Mapping[str, object], *, fidelity_mode: str
) -> ExecutionRealismConfig:
    revision = str(payload.get("execution_model_revision") or "").strip() or None
    if revision is None:
        return ExecutionRealismConfig()
    if revision != EXECUTION_REALISM_V2:
        raise MarketDatasetError(
            "unknown execution model revision", code="FIDELITY_UNSUPPORTED"
        )
    raw_rate = payload.get("participation_rate", "0.1")
    try:
        rate = Decimal(str(raw_rate))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise MarketDatasetError(
            "participation_rate is invalid", code="SCHEMA_UNKNOWN_FIELD"
        ) from exc
    if not rate.is_finite() or rate <= 0 or rate > 1:
        raise MarketDatasetError(
            "participation_rate must be in (0, 1]", code="SCHEMA_UNKNOWN_FIELD"
        )
    try:
        latency_ms = int(payload.get("latency_ms") or 0)
        latency_events = int(payload.get("latency_events") or 0)
    except (TypeError, ValueError) as exc:
        raise MarketDatasetError(
            "latency must be an integer", code="SCHEMA_UNKNOWN_FIELD"
        ) from exc
    if latency_ms < 0 or latency_ms > 60_000:
        raise MarketDatasetError(
            "latency_ms must be between 0 and 60000", code="SCHEMA_UNKNOWN_FIELD"
        )
    if latency_events < 0 or latency_events > 100_000:
        raise MarketDatasetError(
            "latency_events must be between 0 and 100000",
            code="SCHEMA_UNKNOWN_FIELD",
        )
    end_policy = str(payload.get("order_end_policy") or "CANCEL_AT_END")
    if end_policy not in END_POLICIES:
        raise MarketDatasetError(
            "unknown order_end_policy", code="SCHEMA_UNKNOWN_FIELD"
        )
    scenario = str(payload.get("bar_path_scenario") or BAR_PATH_SCENARIO)
    if fidelity_mode == "BAR_APPROX":
        if scenario != BAR_PATH_SCENARIO:
            raise MarketDatasetError(
                "unknown bar_path_scenario", code="FIDELITY_UNSUPPORTED"
            )
        latency_ms = 0
        latency_events = 0
    return ExecutionRealismConfig(
        revision=revision,
        participation_rate=rate,
        latency_ms=latency_ms,
        latency_events=latency_events,
        end_policy=end_policy,
        bar_path_scenario=(scenario if fidelity_mode == "BAR_APPROX" else None),
    )


def source_event_trace(event: object, *, source_kind: str) -> dict[str, object]:
    from app.market_dataset.snapshot import MarketEvent, sha256_hex

    if not isinstance(event, MarketEvent):
        raise TypeError("source event must be MarketEvent")
    canonical = {
        "sequence": event.sequence,
        "event_time_ms": event.event_time_ms,
        "role": event.role,
        "payload": dict(event.payload),
    }
    return {
        "source_event_kind": source_kind,
        "source_sequence": event.sequence,
        "source_event_time_ms": event.event_time_ms,
        "source_event_hash": "sha256:" + sha256_hex(canonical),
    }
