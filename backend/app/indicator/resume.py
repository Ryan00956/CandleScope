"""Pure planning helpers for bounded indicator WebSocket resume patches."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True, slots=True)
class IndicatorResumePlan:
    status: str
    reason: str
    start: int | None = None
    end: int | None = None
    bars: int = 0


def plan_indicator_resume(
    *,
    resume_from: int | None,
    client_server_epoch: str | None,
    client_correction_revision: int | str | None,
    data_revision: dict[str, Any] | None,
    closed_bar_times: Iterable[int],
    max_patch_bars: int = 32,
    interval_seconds: int | None = None,
) -> IndicatorResumePlan:
    """Choose ``up_to_date``, a small WS ``patch``, or HTTP history fallback."""
    try:
        resume_s = int(resume_from or 0)
    except (TypeError, ValueError):
        resume_s = 0
    if resume_s <= 0:
        return IndicatorResumePlan("history_required", "cold-cache")

    revision = data_revision if isinstance(data_revision, dict) else {}
    current_epoch = str(revision.get("serverEpoch") or "")
    current_correction = str(revision.get("correctionRevision") or "0")
    if not client_server_epoch or str(client_server_epoch) != current_epoch:
        return IndicatorResumePlan("history_required", "server-epoch-mismatch")
    if client_correction_revision is None or str(client_correction_revision) != current_correction:
        return IndicatorResumePlan("history_required", "correction-revision-mismatch")
    if bool(revision.get("historyInvalid")):
        return IndicatorResumePlan("history_required", "revision-history-expired")

    times = sorted({int(value) for value in closed_bar_times if int(value) > resume_s})
    if not times:
        try:
            closed_through = int(revision.get("closedThrough") or 0)
        except (TypeError, ValueError):
            closed_through = 0
        if closed_through > resume_s:
            return IndicatorResumePlan("history_required", "closed-tail-missing")
        return IndicatorResumePlan("up_to_date", "covered")

    limit = max(0, int(max_patch_bars))
    if limit <= 0 or len(times) > limit:
        return IndicatorResumePlan("history_required", "resume-gap-too-large", bars=len(times))
    if interval_seconds and interval_seconds > 0 and times[0] > resume_s + int(interval_seconds):
        return IndicatorResumePlan("history_required", "resume-gap-not-contiguous", bars=len(times))
    return IndicatorResumePlan(
        "patch",
        "small-contiguous-gap",
        start=times[0],
        end=times[-1],
        bars=len(times),
    )


__all__ = ["IndicatorResumePlan", "plan_indicator_resume"]
