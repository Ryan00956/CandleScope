"""Interval alignment and replay.v3 control planning primitives."""

from __future__ import annotations

import math

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    interval_tiles,
    is_monthly_interval,
    parse_interval_ms,
    parse_interval_spec,
)
from app.replay.display_time import SourceBucketTimeMapper
from app.replay.models import MAX_TIMESTAMP_MS, validate_timestamp_ms

from .errors import TrainingRunError
from .models import AdvanceBasis, coerce_enum, validate_v2_counter


MAX_CONTROL_COUNT = 100_000
MAX_PLAYBACK_RATE = 10_000
MAX_PLAYBACK_BATCH_UNITS = 128
ADVANCE_CONTRACT_VERSION = "replay.advance.v1"
PLAYBACK_CONTRACT_VERSION = "replay.playback.v1"


def advance_basis(value: object) -> AdvanceBasis:
    try:
        return coerce_enum(AdvanceBasis, value, field_name="advance basis")
    except (TypeError, ValueError) as exc:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "advance basis is unsupported",
            status_code=422,
            details={"basis": value},
        ) from exc


def control_rate(value: object, *, field_name: str = "rate") -> int:
    try:
        rate = validate_v2_counter(value, field_name=field_name)
    except (TypeError, ValueError) as exc:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            f"{field_name} is invalid",
            status_code=422,
        ) from exc
    if not 1 <= rate <= MAX_PLAYBACK_RATE:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            f"{field_name} must be between 1 and {MAX_PLAYBACK_RATE}",
            status_code=422,
        )
    return rate


def virtual_duration_ms(
    value: object,
    *,
    source_kind: str,
    base_interval: str,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "virtual-time duration must be a positive integer number of milliseconds",
            status_code=422,
        )
    if source_kind == "BAR":
        return validate_bar_duration_ms(
            duration_ms=value,
            base_interval=base_interval,
        )
    if source_kind != "AGG_TRADE":
        raise TrainingRunError(
            "REPLAY_CONTROL_UNSUPPORTED",
            "virtual-time duration requires a BAR or AGG_TRADE source",
            status_code=409,
        )
    return value


def supported_advance_bases(
    *,
    source_kind: str,
    full_track_count: int,
) -> tuple[AdvanceBasis, ...]:
    if (
        isinstance(full_track_count, bool)
        or not isinstance(full_track_count, int)
        or full_track_count < 1
    ):
        raise TypeError("full_track_count must be a positive integer")
    if source_kind in {"BAR", "AGG_TRADE"}:
        values = [
            AdvanceBasis.DISPLAY_BAR,
            AdvanceBasis.BASE_BAR,
            AdvanceBasis.VIRTUAL_TIME,
        ]
    else:
        raise TypeError("source_kind must be BAR or AGG_TRADE")
    if full_track_count == 1:
        values.insert(2, AdvanceBasis.SOURCE_EVENT)
    return tuple(values)


def supported_playback_bases(
    *,
    source_kind: str,
    full_track_count: int,
) -> tuple[AdvanceBasis, ...]:
    """Return bases whose wall-clock cadence is unambiguous for this Run.

    BAR virtual-time advances remain available as bounded manual controls, but
    automatic BAR playback is deliberately discrete: its public rate is bars
    per second, never an overloaded historical-time multiplier.
    """

    if source_kind == "BAR":
        values = [AdvanceBasis.DISPLAY_BAR, AdvanceBasis.BASE_BAR]
        if full_track_count == 1:
            values.append(AdvanceBasis.SOURCE_EVENT)
        return tuple(values)
    if source_kind == "AGG_TRADE":
        return supported_advance_bases(
            source_kind=source_kind,
            full_track_count=full_track_count,
        )
    raise TypeError("source_kind must be BAR or AGG_TRADE")


def default_playback_basis(source_kind: str) -> AdvanceBasis:
    if source_kind == "BAR":
        return AdvanceBasis.BASE_BAR
    if source_kind == "AGG_TRADE":
        return AdvanceBasis.VIRTUAL_TIME
    raise TypeError("source_kind must be BAR or AGG_TRADE")


def discrete_playback_units(
    elapsed_seconds: object,
    *,
    rate: int,
    max_units: int = MAX_PLAYBACK_BATCH_UNITS,
) -> int:
    if (
        isinstance(elapsed_seconds, bool)
        or not isinstance(elapsed_seconds, (int, float))
        or not math.isfinite(elapsed_seconds)
        or elapsed_seconds < 0
    ):
        raise TypeError("elapsed_seconds must be a finite non-negative number")
    normalized_rate = control_rate(rate)
    if (
        isinstance(max_units, bool)
        or not isinstance(max_units, int)
        or max_units < 1
    ):
        raise TypeError("max_units must be a positive integer")
    due = math.floor((float(elapsed_seconds) * normalized_rate) + 1e-9)
    return min(max_units, max(0, due))


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
    """Validate an exactly tileable display/control interval without moving the clock."""

    fixed_interval_ms(base_interval, field_name="base_interval")
    base_spec = parse_interval_spec(base_interval)
    step_spec = (
        parse_interval_spec(step_interval)
        if isinstance(step_interval, str)
        else None
    )
    if step_spec is None:
        raise TrainingRunError(
            "REPLAY_CONTROL_UNSUPPORTED_INTERVAL",
            "step_interval is invalid",
            status_code=422,
            details={"step_interval": step_interval},
        )
    step_ms = step_spec.nominal_ms
    if base_spec is None or not interval_tiles(base_spec, step_spec):
        raise TrainingRunError(
            "REPLAY_CONTROL_UNSUPPORTED_INTERVAL",
            "step interval must be exactly tileable by base interval",
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
    remaining = steps if current >= bucket_close else steps - 1
    target = bucket_close
    if is_monthly_interval(step_interval):
        bucket_open = bucket_start
        try:
            for _ in range(remaining):
                bucket_open = compute_bucket_end_ms(
                    bucket_open,
                    step_ms,
                    interval=step_interval,
                )
            target = compute_bucket_end_ms(
                bucket_open,
                step_ms,
                interval=step_interval,
            ) - 1
        except (OverflowError, ValueError) as exc:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "step target exceeds the timestamp range",
                status_code=422,
            ) from exc
    else:
        target += remaining * step_ms
    if target > MAX_TIMESTAMP_MS:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "step target exceeds the timestamp range",
            status_code=422,
        )
    return target


def source_aligned_step_target_ms(
    *,
    current_virtual_time_ms: int,
    actual_replay_start_ms: int,
    public_replay_start_ms: int,
    source_bucket_anchor_ms: int | None,
    base_interval: str,
    step_interval: str,
    count: int,
) -> int:
    """Return a public cursor target on the frozen source bucket grid.

    Blind replay preserves elapsed time while replacing the real calendar with
    a synthetic one.  A display bucket therefore has to be completed on its
    exchange/source boundary, not on an unrelated wall-clock boundary in the
    synthetic public timeline.
    """

    current = validate_timestamp_ms(
        current_virtual_time_ms,
        field_name="current_virtual_time_ms",
    )
    actual_start = validate_timestamp_ms(
        actual_replay_start_ms,
        field_name="actual_replay_start_ms",
    )
    public_start = validate_timestamp_ms(
        public_replay_start_ms,
        field_name="public_replay_start_ms",
    )
    compatible_step_interval_ms(
        base_interval=base_interval,
        step_interval=step_interval,
    )
    steps = control_count(count)
    if current < public_start:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "display step cursor precedes the public replay origin",
            status_code=422,
        )
    elapsed_ms = current - public_start
    if actual_start > MAX_TIMESTAMP_MS - elapsed_ms:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "display step cursor exceeds the timestamp range",
            status_code=422,
        )
    actual_current = actual_start + elapsed_ms
    try:
        mapper = SourceBucketTimeMapper.create(
            interval=step_interval,
            actual_replay_start_ms=actual_start,
            public_replay_start_ms=public_start,
            source_bucket_anchor_ms=source_bucket_anchor_ms,
        )
        bucket_open = mapper.actual_containing_bucket_open(actual_current)
        bucket_close = mapper.actual_bucket_end(bucket_open) - 1
        remaining = steps if actual_current >= bucket_close else steps - 1
        if mapper.monthly_count is None:
            actual_target = bucket_close + remaining * mapper.interval_ms
        else:
            for _ in range(remaining):
                bucket_open = mapper.actual_bucket_end(bucket_open)
            actual_target = mapper.actual_bucket_end(bucket_open) - 1
    except (OverflowError, ValueError) as exc:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "display step target exceeds the source bucket grid",
            status_code=422,
        ) from exc
    if actual_target > MAX_TIMESTAMP_MS:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "display step target exceeds the timestamp range",
            status_code=422,
        )
    target_delta_ms = actual_target - actual_start
    if target_delta_ms < 0 or public_start > MAX_TIMESTAMP_MS - target_delta_ms:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "display step target exceeds the timestamp range",
            status_code=422,
        )
    target = public_start + target_delta_ms
    if target <= current:
        raise TrainingRunError(
            "REPLAY_CONTROL_INVALID",
            "display step target must advance the replay cursor",
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
    "ADVANCE_CONTRACT_VERSION",
    "MAX_PLAYBACK_BATCH_UNITS",
    "MAX_PLAYBACK_RATE",
    "MAX_CONTROL_COUNT",
    "PLAYBACK_CONTRACT_VERSION",
    "advance_basis",
    "aligned_step_target_ms",
    "compatible_step_interval_ms",
    "control_count",
    "control_rate",
    "default_playback_basis",
    "discrete_playback_units",
    "fixed_interval_ms",
    "source_aligned_step_target_ms",
    "supported_advance_bases",
    "supported_playback_bases",
    "validate_bar_duration_ms",
    "virtual_duration_ms",
]
