"""Fail-closed interval rules for immutable local dataset resampling."""

from __future__ import annotations

from dataclasses import dataclass

from app.data_engine.interval_policy import IntervalAlignment, IntervalSpec, parse_interval_spec


MAX_LOCAL_RESAMPLE_FACTOR = 10_000


class LocalResamplingError(ValueError):
    def __init__(self, message: str, *, code: str = "interval_not_composable") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class LocalResamplePlan:
    source: IntervalSpec
    target: IntervalSpec
    factor: int
    derived: bool


def resolve_local_resample_plan(
    source_interval: str,
    target_interval: str,
    *,
    alignment_offset_ms: int,
) -> LocalResamplePlan:
    """Resolve an exact or derived local interval without inventing time semantics."""
    source = parse_interval_spec(source_interval)
    target = parse_interval_spec(target_interval)
    if source is None:
        raise LocalResamplingError(
            f"Dataset source interval is invalid: {source_interval}",
            code="dataset_corrupt",
        )
    if target is None:
        raise LocalResamplingError(
            f"Unsupported interval: {target_interval}",
            code="interval_not_available",
        )
    if source.signature == target.signature:
        return LocalResamplePlan(source=source, target=source, factor=1, derived=False)
    if target.nominal_ms <= source.nominal_ms:
        raise LocalResamplingError(
            f"Cannot derive {target.canonical} from {source.canonical}: "
            "local resampling only builds larger intervals",
        )
    if (
        source.alignment is not IntervalAlignment.FIXED_EPOCH
        or target.alignment is not IntervalAlignment.FIXED_EPOCH
    ):
        raise LocalResamplingError(
            f"Cannot derive {target.canonical} from {source.canonical}: "
            "derived local intervals currently support fixed second, minute, hour, and day grids only",
        )
    if alignment_offset_ms != 0:
        raise LocalResamplingError(
            f"Cannot derive {target.canonical} from {source.canonical}: "
            "source timestamps are not aligned to the UTC interval grid",
            code="interval_alignment_incompatible",
        )
    if target.nominal_ms % source.nominal_ms != 0:
        raise LocalResamplingError(
            f"Cannot derive {target.canonical} from {source.canonical}: "
            f"{target.canonical} is not an integer multiple of {source.canonical}",
        )
    factor = target.nominal_ms // source.nominal_ms
    if factor > MAX_LOCAL_RESAMPLE_FACTOR:
        raise LocalResamplingError(
            f"Cannot derive {target.canonical} from {source.canonical}: "
            f"aggregation factor {factor} exceeds the local safety limit "
            f"of {MAX_LOCAL_RESAMPLE_FACTOR}",
            code="interval_resample_factor_too_large",
        )
    return LocalResamplePlan(source=source, target=target, factor=factor, derived=True)
