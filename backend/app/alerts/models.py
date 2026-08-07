"""Shared alert domain models.

The alert module owns rule definition and trigger history. Concrete delivery
channels live behind dispatcher adapters so the core can stay independent from
email, Telegram, trading, or other optional integrations.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


VALID_TRIGGER_ON = {"realtime", "bar_update", "bar_close"}
VALID_ACTION_TYPES = {
    "in_app",
    "browser",
    "sound",
    "email",
    "telegram",
    "webhook",
    "trading_signal",
}
DELIVERABLE_ACTION_TYPES = {"in_app", "browser", "sound"}


class AlertTarget(BaseModel):
    exchange: str = "binance"
    marketType: str = "spot"
    symbol: str = ""
    interval: str = "1m"


class AlertAction(BaseModel):
    type: str = "in_app"
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class AlertRulePayload(BaseModel):
    schemaVersion: int = 1
    id: str | None = None
    name: str = "Untitled Alert"
    description: str = ""
    enabled: bool = True
    target: AlertTarget = Field(default_factory=AlertTarget)
    triggerOn: str = "bar_close"
    expression: dict[str, Any] = Field(default_factory=dict)
    actions: list[AlertAction] = Field(default_factory=lambda: [AlertAction(type="in_app")])
    cooldownMs: int = 30_000
    expiresAt: int | None = None
    maxTriggers: int | None = 1
    afterTrigger: str = "auto_disable"
    tags: list[str] = Field(default_factory=list)


class AlertEnabledPatch(BaseModel):
    enabled: bool


class AlertAcknowledgedPatch(BaseModel):
    acknowledged: bool = True


class AlertDispatchReceiptPayload(BaseModel):
    status: str
    detail: str = ""


class AlertTriggerPayload(BaseModel):
    ruleId: str
    eventType: str = "alert.triggered"
    target: dict[str, Any] = Field(default_factory=dict)
    message: str = ""
    values: dict[str, Any] = Field(default_factory=dict)
    actions: list[dict[str, Any]] = Field(default_factory=list)


class AlertEvaluatePayload(BaseModel):
    expression: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)


def dump_model(model: BaseModel) -> dict[str, Any]:
    """Return a pydantic v1/v2 compatible dict."""
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()
