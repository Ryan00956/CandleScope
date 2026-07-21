"""Phase 3 interval alignment and replay.v2 control planning primitives."""

from __future__ import annotations

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
)
from app.replay.models import MAX_TIMESTAMP_MS, validate_timestamp_ms

from .errors import TrainingRunError
from .models import validate_v2_counter


MAX_CONTROL_COUNT = 100_000


def fixed_interval_ms(interval: object, *, field_name: str) -> int:
    if not isinstance(interval, str) or not interval:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            f"{field_name} must be a fixed-duration interval",
            status_code=422,
        )
    parsed = parse_interval_ms(interval)
    if parsed is None or parsed <= 0 or is_monthly_interval(interval):
        raise TrainingRunError(
            "REPLAY_CONTROL_UNSUPPORTED_INTERVAL",
            f"{field_name} must be a fixed-duration interval",
            status_code=422,
            details={"interval": interval},
        )
    return parsed


def control_count(value: object, *, field_name: str = "count") -> int:
    try:
        count = validate_v2_counter(value, field_name=field_name)
    except (TypeError, ValueError) as exc:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            f"{field_name} is invalid",
            status_code=422,
        ) from exc
    if count < 1 or count > MAX_CONTROL_COUNT:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            f"{field_name} must be between 1 and {MAX_CONTROL_COUNT}",
            status_code=422,
        )
    return count


def compatible_step_interval_ms(
    *,
    base_interval: str,
    step_interval: str,
) -> int:
    """Validate a fixed display/control interval without moving the clock."""

    base_ms = fixed_interval_ms(base_interval, field_name="base_interval")
    step_ms = fixed_interval_ms(step_interval, field_name="step_interval")
    if step_ms < base_ms or step_ms % base_ms != 0:
        raise TrainingRunError(
            "REPLAY_CONTROL_UNSUPPORTED_INTERVAL",
            "step interval must be an integer multiple of base interval",
            status_code=422,
            details={
                "base_interval": base_interval,
                "step_interval": step_interval,
            },
        )
    return step_ms


def aligned_step_target_ms(
    *,
    current_virtual_time_ms: int,
    base_interval: str,
    step_interval: str,
    count: int,
) -> int:
    """Return the last millisecond of the final bucket consumed by a step.

    A cursor inside a bucket first finishes that bucket. A cursor already on a
    bucket close advances into the next bucket. This is shared by BAR display
    stepping and AGG_TRADE base/display stepping.
    """

    current = validate_timestamp_ms(
        current_virtual_time_ms,
        field_name="current_virtual_time_ms",
    )
    step_ms = compatible_step_interval_ms(
        base_interval=base_interval,
        step_interval=step_interval,
    )
    steps = control_count(count)
    bucket_start = compute_bucket_start_ms(current, step_ms, interval=step_interval)
    bucket_close = (
        compute_bucket_end_ms(bucket_start, step_ms, interval=step_interval) - 1
    )
    target = bucket_close + (steps if current >= bucket_close else steps - 1) * step_ms
    if target > MAX_TIMESTAMP_MS:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "step target exceeds the timestamp range",
            status_code=422,
        )
    return target


def validate_bar_duration_ms(*, duration_ms: object, base_interval: str) -> int:
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "duration must be an integer number of milliseconds",
            status_code=422,
        )
    base_ms = fixed_interval_ms(base_interval, field_name="base_interval")
    if duration_ms <= 0 or duration_ms % base_ms != 0:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "BAR duration must be a positive integer multiple of base interval",
            status_code=422,
            details={"base_interval": base_interval},
        )
    return duration_ms


__all__ = [
    "MAX_CONTROL_COUNT",
    "aligned_step_target_ms",
    "compatible_step_interval_ms",
    "control_count",
    "fixed_interval_ms",
    "validate_bar_duration_ms",
]
