"""Server-authoritative actual-to-public time projection for replay training."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TypedDict

from app.replay.models import validate_timestamp_ms

from .models import TimeDisclosurePolicy, coerce_enum, validate_v2_counter


_DAY_MS = 86_400_000
_HOUR_MS = 3_600_000
_MINUTE_MS = 60_000


class PublicTime(TypedDict):
    policy: str
    timeline_ms: int
    relative_ms: int
    sequence: int
    label: str


def _relative_prefix(value: int, unit_ms: int, suffix: str) -> str:
    units = abs(value) // unit_ms
    sign = "+" if value >= 0 else "-"
    return f"T{sign}{units}{suffix}"


def _training_day(relative_ms: int) -> str:
    if relative_ms >= 0:
        return f"D+{relative_ms // _DAY_MS + 1}"
    return f"D-{((-relative_ms - 1) // _DAY_MS) + 1}"


def _relative_clock(relative_ms: int) -> str:
    within_day = abs(relative_ms) % _DAY_MS
    hours, remainder = divmod(within_day, _HOUR_MS)
    minutes, remainder = divmod(remainder, _MINUTE_MS)
    seconds = remainder // 1_000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def project_public_time(
    *,
    actual_time_ms: int,
    public_time_ms: int,
    actual_origin_ms: int,
    public_origin_ms: int,
    policy: TimeDisclosurePolicy | str,
    sequence: int,
) -> PublicTime:
    """Return a bounded public clock value without retaining hidden units.

    ``public_time_ms`` is the already-remapped monotonic actor time for hidden
    runs.  It is the only numeric timeline sent to a client.  Calendar labels
    are produced here from the server-owned actual timestamp and then discard
    every unit hidden by the selected policy.
    """

    actual = validate_timestamp_ms(actual_time_ms, field_name="actual_time_ms")
    public = validate_timestamp_ms(public_time_ms, field_name="public_time_ms")
    actual_origin = validate_timestamp_ms(
        actual_origin_ms,
        field_name="actual_origin_ms",
    )
    public_origin = validate_timestamp_ms(
        public_origin_ms,
        field_name="public_origin_ms",
    )
    normalized_policy = coerce_enum(
        TimeDisclosurePolicy,
        policy,
        field_name="time_disclosure_policy",
    )
    ordinal = validate_v2_counter(sequence, field_name="sequence")
    actual_delta = actual - actual_origin
    public_delta = public - public_origin
    if actual_delta != public_delta:
        raise ValueError("public timeline offset does not match the actual timeline")
    instant = datetime.fromtimestamp(actual / 1_000, tz=UTC)
    if normalized_policy is TimeDisclosurePolicy.NONE:
        label = instant.strftime("%Y-%m-%d %H:%M:%S")
        timeline = actual
    elif normalized_policy is TimeDisclosurePolicy.HIDE_YEAR:
        label = instant.strftime("%m-%d %H:%M:%S")
        timeline = public
    elif normalized_policy is TimeDisclosurePolicy.HIDE_MONTH:
        label = instant.strftime("%d %H:%M:%S")
        timeline = public
    elif normalized_policy is TimeDisclosurePolicy.HIDE_DAY:
        label = f"{_training_day(actual_delta)} {instant:%H:%M:%S}"
        timeline = public
    elif normalized_policy is TimeDisclosurePolicy.HIDE_HOUR:
        label = (
            f"{_relative_prefix(actual_delta, _HOUR_MS, 'h')} "
            f"{instant:%M:%S}"
        )
        timeline = public
    elif normalized_policy is TimeDisclosurePolicy.HIDE_MINUTE:
        label = (
            f"{_relative_prefix(actual_delta, _MINUTE_MS, 'm')} "
            f"{instant:%S}"
        )
        timeline = public
    else:
        label = f"{_training_day(actual_delta)} T+{_relative_clock(actual_delta)}"
        timeline = public
    return {
        "policy": normalized_policy.value,
        "timeline_ms": timeline,
        "relative_ms": actual_delta,
        "sequence": ordinal,
        "label": label,
    }


__all__ = ["PublicTime", "project_public_time"]
