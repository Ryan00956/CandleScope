"""Revealed-only history pages for the replay training workspace."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from functools import lru_cache

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
)
from app.replay.bars.builder import ReplayBarBuilder, ReplayDisplayBar
from app.replay.bars.schedule import ReplayBarSchedule
from app.replay.canonical import canonical_sha256
from app.replay.catalog import KlinesReadRepository
from app.replay.dataset import (
    BarDatasetSnapshot,
    ReplayBar,
    remap_bar_snapshot_time,
    validate_replay_repository_bar,
)
from app.replay.display_time import SourceBucketTimeMapper
from app.replay.errors import ReplayDomainError
from app.replay.market_halts import ReplayBarHalt, validate_registered_bar_halts
from app.replay.models import ReplaySessionConfig

from .errors import TrainingRunError


HISTORY_SCHEMA_VERSION = "replay.history.v3"
HISTORY_EPOCH_SCHEMA_VERSION = "replay.history-epoch.v5"
MAX_HISTORY_PAGE_BARS = 1_000
MAX_HISTORY_QUERY_BASE_ROWS = 100_000
SNAPSHOT_DECODE_CACHE_SIZE = 8


def _previous_bucket_start_ms(
    bucket_start_ms: int,
    interval_ms: int,
    *,
    interval: str,
) -> int:
    if bucket_start_ms <= 0:
        return -1
    return compute_bucket_start_ms(
        bucket_start_ms - 1,
        interval_ms,
        interval=interval,
    )


@dataclass(frozen=True, slots=True)
class _NativeDisplayHistoryContext:
    mapper: SourceBucketTimeMapper
    actual_boundary_ms: int
    public_boundary_ms: int
    source_revision: str | None


@dataclass(frozen=True, slots=True)
class _HistoryExcludedRange:
    start_ms: int
    end_ms: int
    reason: str
    source_reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "reason": self.reason,
            "source_reason": self.source_reason,
        }


@dataclass(frozen=True, slots=True)
class _HistoryPageResult:
    bars: tuple[ReplayDisplayBar, ...]
    next_before_ms: int
    has_more: bool
    excluded_ranges: tuple[_HistoryExcludedRange, ...] = ()


@dataclass(frozen=True, slots=True)
class _DecodedBarSnapshotBlob:
    snapshot: BarDatasetSnapshot
    paging_manifest: Mapping[str, object] | None


def _fail(code: str, message: str, *, status_code: int = 409) -> TrainingRunError:
    return TrainingRunError(code, message, status_code=status_code)


@lru_cache(maxsize=SNAPSHOT_DECODE_CACHE_SIZE)
def _decode_bar_snapshot_blob(blob: bytes) -> _DecodedBarSnapshotBlob:
    decoded = json.loads(blob.decode("utf-8"))
    if not isinstance(decoded, Mapping):
        raise TypeError("snapshot root must be an object")
    bar_payload = decoded.get("bar_dataset", decoded)
    if not isinstance(bar_payload, Mapping):
        raise TypeError("bar dataset must be an object")
    raw_manifest = decoded.get("paging_manifest")
    manifest = raw_manifest if isinstance(raw_manifest, Mapping) else None
    return _DecodedBarSnapshotBlob(
        snapshot=BarDatasetSnapshot.from_dict(bar_payload),
        paging_manifest=manifest,
    )


@lru_cache(maxsize=SNAPSHOT_DECODE_CACHE_SIZE)
def _decode_blind_bar_snapshot_blob(
    blob: bytes,
    synthetic_origin_ms: int,
) -> BarDatasetSnapshot:
    snapshot = _decode_bar_snapshot_blob(blob).snapshot
    repository_backend = snapshot.provenance.repository_backend
    remapped = remap_bar_snapshot_time(
        snapshot,
        synthetic_replay_start_ms=synthetic_origin_ms,
    )
    # Actor checkpoints intentionally use the redacted synthetic backend, but
    # server-side ALL_AVAILABLE reads still need the persisted source identity
    # to reject legacy Runs after a repository migration.
    return replace(
        remapped,
        provenance=replace(
            remapped.provenance,
            repository_backend=repository_backend,
        ),
    )


def _decode_bar_snapshot(
    persisted: Mapping[str, object],
    *,
    config: ReplaySessionConfig,
) -> BarDatasetSnapshot:
    blob = persisted.get("snapshot_blob")
    if not isinstance(blob, (bytes, bytearray)):
        raise _fail(
            "HISTORY_SNAPSHOT_UNAVAILABLE",
            "training history snapshot is unavailable",
            status_code=503,
        )
    encoded = bytes(blob)
    synthetic_origin: int | None = None
    if config.blind_mode:
        raw_origin = persisted.get("synthetic_origin_ms")
        if isinstance(raw_origin, bool) or not isinstance(raw_origin, int):
            raise _fail(
                "HISTORY_SNAPSHOT_INVALID",
                "blind training history snapshot is invalid",
                status_code=503,
            )
        synthetic_origin = raw_origin
    try:
        snapshot = (
            _decode_blind_bar_snapshot_blob(encoded, synthetic_origin)
            if synthetic_origin is not None
            else _decode_bar_snapshot_blob(encoded).snapshot
        )
    except (UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training history snapshot is invalid",
            status_code=503,
        ) from exc
    return snapshot


def _decode_verified_market_halts(
    persisted: Mapping[str, object],
    *,
    snapshot: BarDatasetSnapshot,
    config: ReplaySessionConfig,
) -> tuple[ReplayBarHalt, ...]:
    """Read exact reviewed halt decisions from a paged BAR session manifest."""

    manifest: Mapping[str, object] | None = None
    snapshot_ref = persisted.get("snapshot_ref")
    if isinstance(snapshot_ref, Mapping):
        raw_manifest = snapshot_ref.get("paging_manifest")
        if isinstance(raw_manifest, Mapping):
            manifest = raw_manifest
    if manifest is None:
        blob = persisted.get("snapshot_blob")
        if isinstance(blob, (bytes, bytearray)):
            try:
                manifest = _decode_bar_snapshot_blob(bytes(blob)).paging_manifest
            except (UnicodeError, json.JSONDecodeError, TypeError, ValueError):
                manifest = None
    if (
        manifest is None
        or manifest.get("schema_version") != "replay-paged-bar-manifest.v2"
    ):
        return ()

    interval_ms = parse_interval_ms(config.base_interval)
    if interval_ms is None or interval_ms < 1:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training base interval is invalid",
            status_code=503,
        )
    try:
        return validate_registered_bar_halts(
            manifest.get("verified_market_halts"),
            identity=snapshot.identity,
            interval_ms=interval_ms,
        )
    except (TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training verified halt manifest is invalid",
            status_code=503,
        ) from exc


def _identity(
    binding: Mapping[str, object],
    config: ReplaySessionConfig,
    *,
    display_interval: str,
) -> dict[str, str]:
    return {
        "exchange": config.exchange,
        "market_type": config.market_type,
        "symbol": config.symbol,
        "source_kind": config.source_kind.value.upper(),
        "base_interval": config.base_interval,
        "display_interval": display_interval,
    }


def _assert_source_binding(
    binding: Mapping[str, object],
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    *,
    display_interval: str,
) -> dict[str, str]:
    identity = _identity(
        binding,
        config,
        display_interval=display_interval,
    )
    immutable_expected = {
        "exchange": binding["exchange"],
        "market_type": binding["market_type"],
        "symbol": binding["symbol"],
        "source_kind": binding["source_kind"],
        "base_interval": binding["base_interval"],
    }
    snapshot_identity = snapshot.identity.to_dict()
    if (
        {key: identity[key] for key in immutable_expected} != immutable_expected
        or config.display_interval != binding["display_interval"]
        or snapshot_identity["exchange"] != identity["exchange"]
        or snapshot_identity["market_type"] != identity["market_type"]
        or snapshot_identity["symbol"] != identity["symbol"]
        or snapshot.interval != identity["base_interval"]
    ):
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "training history source identity changed",
        )
    return identity


def _history_epoch(
    *,
    binding: Mapping[str, object],
    identity: Mapping[str, str],
    snapshot: BarDatasetSnapshot,
    data_epoch: str,
    history_boundary_ms: int,
    policy_hash: str,
    history_source: Mapping[str, object],
) -> str:
    return canonical_sha256(
        {
            "schema_version": HISTORY_EPOCH_SCHEMA_VERSION,
            "run_id": binding["run_id"],
            "session_id": binding["session_id"],
            "track_id": binding["track_id"],
            "identity": dict(identity),
            "data_epoch": data_epoch,
            "bar_data_epoch": snapshot.data_epoch,
            "public_replay_start_ms": snapshot.replay_start_ms,
            "history_boundary_ms": history_boundary_ms,
            "policy_hash": policy_hash,
            "history_source": dict(history_source),
            "row_count": snapshot.row_count,
        }
    )


def _history_mode(raw_policy: Mapping[str, object]) -> str:
    lookback = raw_policy.get("visible_history_lookback")
    if not isinstance(lookback, Mapping) or set(lookback) != {"mode", "duration_ms"}:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is invalid",
            status_code=503,
        )
    mode = lookback.get("mode")
    duration_ms = lookback.get("duration_ms")
    if (
        mode not in {"DURATION", "ALL_AVAILABLE"}
        or (
            mode == "DURATION"
            and (
                isinstance(duration_ms, bool)
                or not isinstance(duration_ms, int)
                or duration_ms < 1
            )
        )
        or (mode == "ALL_AVAILABLE" and duration_ms is not None)
    ):
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is invalid",
            status_code=503,
        )
    return str(mode)


def _safe_bound(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _validated_display_grid_binding(
    binding: Mapping[str, object],
    *,
    display_interval: str,
    source_revision: str | None,
) -> tuple[int | None, str | None, str | None]:
    """Validate the internal pinned-grid commitment without exposing its anchor."""

    raw_anchor = binding.get("display_source_bucket_anchor_ms")
    raw_alignment = binding.get("display_alignment_policy")
    raw_commitment = binding.get("display_grid_commitment")
    if source_revision is None:
        if any(
            value is not None for value in (raw_anchor, raw_alignment, raw_commitment)
        ):
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "native display grid is not bound to a source revision",
                status_code=503,
            )
        return None, None, None
    if (
        isinstance(raw_anchor, bool)
        or not isinstance(raw_anchor, int)
        or not isinstance(raw_alignment, str)
        or not raw_alignment
        or not isinstance(raw_commitment, str)
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "pinned native display grid is invalid",
            status_code=503,
        )
    expected_commitment = canonical_sha256(
        {
            "schema_version": "replay.display-source-grid.v1",
            "source_revision": source_revision,
            "display_interval": display_interval,
            "source_bucket_anchor_ms": raw_anchor,
            "alignment_policy": raw_alignment,
        }
    )
    if raw_commitment != expected_commitment:
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "pinned native display grid commitment changed",
            status_code=503,
        )
    return raw_anchor, raw_alignment, raw_commitment


def _query_bound_repository(
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
    symbol: str,
    interval: str,
    *,
    start_ms: int,
    end_ms: int,
    limit: int,
    order: str,
    exchange: str,
    market_type: str,
    source_revision_override: str | None = None,
) -> list[dict]:
    source_revision = (
        snapshot.provenance.source_revision
        if source_revision_override is None
        else source_revision_override
    )
    query_at_revision = getattr(repository, "query_bars_at_revision", None)
    if source_revision is not None:
        if not callable(query_at_revision):
            raise RuntimeError(
                "bound replay-history revision cannot be read by this repository"
            )
        return query_at_revision(
            source_revision,
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
            exchange=exchange,
            market_type=market_type,
        )
    _assert_legacy_repository_backend(repository, snapshot)
    return repository.query_bars(
        symbol,
        interval,
        start_ms=start_ms,
        end_ms=end_ms,
        limit=limit,
        order=order,
        exchange=exchange,
        market_type=market_type,
    )


def _assert_legacy_repository_backend(
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
) -> None:
    repository_backend = (
        f"{type(repository).__module__}.{type(repository).__qualname__}"
    )
    if snapshot.provenance.repository_backend != repository_backend:
        raise _fail(
            "HISTORY_SOURCE_MIGRATION_REQUIRED",
            "legacy training history is not revision-bound to the active replay source",
            status_code=409,
        )


def _bound_source_start_ms(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    actual_replay_start_ms: int,
    fallback_start_ms: int,
    interval_ms: int,
) -> tuple[int, str]:
    """Resolve the immutable listing boundary, including for pre-v3 Runs."""

    source_revision = snapshot.provenance.source_revision
    try:
        if source_revision is not None:
            get_bounds = getattr(repository, "get_bounds_at_revision", None)
            if not callable(get_bounds):
                raise RuntimeError("bound replay-history revision has no bounds reader")
            bounds = get_bounds(
                source_revision,
                config.symbol,
                config.base_interval,
                exchange=config.exchange,
                market_type=config.market_type,
            )
        else:
            _assert_legacy_repository_backend(repository, snapshot)
            bounds = repository.get_bounds(
                config.symbol,
                config.base_interval,
                exchange=config.exchange,
                market_type=config.market_type,
            )
    except TrainingRunError:
        raise
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "replay history listing boundary could not be read",
            status_code=503,
        ) from exc
    if not isinstance(bounds, Mapping):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history listing boundary is invalid",
            status_code=503,
        )
    if source_revision is not None and bounds.get("source_revision") not in {
        None,
        source_revision,
    }:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history listing boundary revision changed",
            status_code=503,
        )
    raw_start = bounds.get(
        "listing_boundary_ms",
        bounds.get("earliest_open_time"),
    )
    source_start_ms = _safe_bound(raw_start)
    if (
        source_start_ms is None
        or source_start_ms > fallback_start_ms
        or source_start_ms > actual_replay_start_ms
        or compute_bucket_start_ms(
            source_start_ms,
            interval_ms,
            interval=config.base_interval,
        )
        != source_start_ms
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history listing boundary is inconsistent with the Run",
            status_code=503,
        )
    public_start_ms = (
        snapshot.replay_start_ms + source_start_ms - actual_replay_start_ms
    )
    if public_start_ms < 0:
        skipped_rows = (-public_start_ms + interval_ms - 1) // interval_ms
        source_start_ms += skipped_rows * interval_ms
        public_start_ms += skipped_rows * interval_ms
    if public_start_ms < 0 or source_start_ms > fallback_start_ms:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "public replay history cannot represent the source boundary",
            status_code=503,
        )
    boundary_source = str(
        bounds.get(
            "listing_boundary_source",
            "earliest_bound_source_bar",
        )
    )
    if not boundary_source:
        boundary_source = "earliest_bound_source_bar"
    return source_start_ms, boundary_source


def _scan_bound_repository_gaps(
    *,
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
    config: ReplaySessionConfig,
    interval: str,
    interval_ms: int,
    start_ms: int,
    end_ms: int,
    source_revision_override: str | None = None,
) -> list[tuple[int, int, str]]:
    if start_ms > end_ms:
        return []
    source_revision = (
        snapshot.provenance.source_revision
        if source_revision_override is None
        else source_revision_override
    )
    try:
        if source_revision is not None:
            scan_gaps = getattr(repository, "scan_gaps_at_revision", None)
            if not callable(scan_gaps):
                raise RuntimeError("bound replay-history revision has no gap reader")
            payload = scan_gaps(
                source_revision,
                config.symbol,
                interval,
                start_ms=start_ms,
                end_ms=end_ms,
                exchange=config.exchange,
                market_type=config.market_type,
                limit=MAX_HISTORY_QUERY_BASE_ROWS,
            )
        else:
            _assert_legacy_repository_backend(repository, snapshot)
            payload = repository.scan_gaps(
                config.symbol,
                interval,
                start_ms=start_ms,
                end_ms=end_ms,
                exchange=config.exchange,
                market_type=config.market_type,
                limit=MAX_HISTORY_QUERY_BASE_ROWS,
            )
    except TrainingRunError:
        raise
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "replay history gap evidence could not be read",
            status_code=503,
        ) from exc
    if (
        not isinstance(payload, Mapping)
        or payload.get("truncated") is not False
        or not isinstance(payload.get("gaps"), list)
        or (
            source_revision is not None
            and payload.get("source_revision") not in {None, source_revision}
        )
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history gap evidence is incomplete",
            status_code=503,
        )
    gaps: list[tuple[int, int, str]] = []
    try:
        for raw_gap in payload["gaps"]:
            if not isinstance(raw_gap, Mapping):
                raise TypeError("gap must be an object")
            gap_start = int(raw_gap["start_ms"])
            gap_end = int(raw_gap["end_ms"])
            missing_bars = int(raw_gap["missing_bars"])
            reason = str(raw_gap["reason"])
            if (
                gap_start < start_ms
                or gap_end > end_ms
                or gap_start > gap_end
                or not reason
                or compute_bucket_start_ms(
                    gap_start,
                    interval_ms,
                    interval=interval,
                )
                != gap_start
                or compute_bucket_start_ms(
                    gap_end,
                    interval_ms,
                    interval=interval,
                )
                != gap_end
                or missing_bars != ((gap_end - gap_start) // interval_ms) + 1
            ):
                raise ValueError("gap bounds are invalid")
            gaps.append((gap_start, gap_end, reason))
    except (KeyError, TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history gap evidence is invalid",
            status_code=503,
        ) from exc
    gaps.sort()
    if any(current[0] <= previous[1] for previous, current in zip(gaps, gaps[1:])):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history gap evidence overlaps",
            status_code=503,
        )
    return gaps


def _page_holes(
    bars: list[ReplayDisplayBar] | tuple[ReplayDisplayBar, ...],
    *,
    connection_before_ms: int,
) -> list[tuple[int, int]]:
    holes: list[tuple[int, int]] = []
    for previous, current in zip(bars, bars[1:]):
        if current.open_time_ms <= previous.close_time_ms:
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "replay history page is not strictly ordered",
                status_code=503,
            )
        if current.open_time_ms > previous.close_time_ms + 1:
            holes.append((previous.close_time_ms + 1, current.open_time_ms - 1))
    if bars:
        tail_start_ms = bars[-1].close_time_ms + 1
        if tail_start_ms > connection_before_ms:
            raise _fail(
                "HISTORY_CURSOR_INVALID",
                "replay history page crosses its before cursor",
            )
        if tail_start_ms < connection_before_ms:
            holes.append((tail_start_ms, connection_before_ms - 1))
    return holes


def _declared_page_exclusions(
    *,
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
    config: ReplaySessionConfig,
    bars: list[ReplayDisplayBar] | tuple[ReplayDisplayBar, ...],
    connection_before_ms: int,
    timeline_delta_ms: int,
    source_interval: str,
    source_interval_ms: int,
    source_revision_override: str | None = None,
) -> tuple[_HistoryExcludedRange, ...]:
    holes = _page_holes(bars, connection_before_ms=connection_before_ms)
    if not holes:
        return ()
    actual_scan_start_ms = compute_bucket_start_ms(
        holes[0][0] - timeline_delta_ms,
        source_interval_ms,
        interval=source_interval,
    )
    actual_scan_end_ms = compute_bucket_start_ms(
        holes[-1][1] - timeline_delta_ms,
        source_interval_ms,
        interval=source_interval,
    )
    source_gaps = _scan_bound_repository_gaps(
        repository=repository,
        snapshot=snapshot,
        config=config,
        interval=source_interval,
        interval_ms=source_interval_ms,
        start_ms=actual_scan_start_ms,
        end_ms=actual_scan_end_ms,
        source_revision_override=source_revision_override,
    )
    display_interval_ms = parse_interval_ms(config.display_interval)
    if display_interval_ms is None or display_interval_ms < source_interval_ms:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training display interval is invalid",
            status_code=503,
        )
    affected: list[tuple[int, int, str]] = []
    for gap_start_ms, gap_end_ms, source_reason in source_gaps:
        public_gap_start_ms = gap_start_ms + timeline_delta_ms
        public_gap_end_open_ms = gap_end_ms + timeline_delta_ms
        affected_start_ms = compute_bucket_start_ms(
            public_gap_start_ms,
            display_interval_ms,
            interval=config.display_interval,
        )
        affected_end_open_ms = compute_bucket_start_ms(
            public_gap_end_open_ms,
            display_interval_ms,
            interval=config.display_interval,
        )
        affected_end_ms = (
            compute_bucket_end_ms(
                affected_end_open_ms,
                display_interval_ms,
                interval=config.display_interval,
            )
            - 1
        )
        affected.append((affected_start_ms, affected_end_ms, source_reason))

    exclusions: list[_HistoryExcludedRange] = []
    for hole_start_ms, hole_end_ms in holes:
        coverage = sorted(
            (
                max(hole_start_ms, start_ms),
                min(hole_end_ms, end_ms),
                source_reason,
            )
            for start_ms, end_ms, source_reason in affected
            if start_ms <= hole_end_ms and end_ms >= hole_start_ms
        )
        cursor_ms = hole_start_ms
        source_reasons: set[str] = set()
        for start_ms, end_ms, source_reason in coverage:
            if start_ms > cursor_ms:
                break
            cursor_ms = max(cursor_ms, end_ms + 1)
            source_reasons.add(source_reason)
            if cursor_ms > hole_end_ms:
                break
        if cursor_ms <= hole_end_ms or not source_reasons:
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "history page contains an undeclared source gap",
                status_code=503,
            )
        exclusions.append(
            _HistoryExcludedRange(
                start_ms=hole_start_ms,
                end_ms=hole_end_ms,
                reason=(
                    "source_gap"
                    if source_interval == config.display_interval
                    else "source_gap_affected_display_bucket"
                ),
                source_reason=(
                    next(iter(source_reasons))
                    if len(source_reasons) == 1
                    else "multiple_source_gaps"
                ),
            )
        )
    return tuple(exclusions)


def _declared_source_bucket_exclusions(
    *,
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
    config: ReplaySessionConfig,
    bars: list[ReplayDisplayBar] | tuple[ReplayDisplayBar, ...],
    connection_before_ms: int,
    mapper: SourceBucketTimeMapper,
    source_interval: str,
    source_interval_ms: int,
    source_revision_override: str | None = None,
) -> tuple[_HistoryExcludedRange, ...]:
    """Explain omitted native display buckets from the revision gap index."""

    holes = _page_holes(bars, connection_before_ms=connection_before_ms)
    if not holes:
        return ()
    first_public_bucket = compute_bucket_start_ms(
        holes[0][0],
        mapper.interval_ms,
        interval=mapper.interval,
    )
    last_public_bucket = compute_bucket_start_ms(
        holes[-1][1],
        mapper.interval_ms,
        interval=mapper.interval,
    )
    first_ordinal = mapper.public_bucket_ordinal(first_public_bucket)
    last_ordinal = mapper.public_bucket_ordinal(last_public_bucket)
    actual_scan_start_ms = mapper.actual_bucket_open(first_ordinal)
    last_actual_bucket_ms = mapper.actual_bucket_open(last_ordinal)
    actual_scan_end_ms = (
        last_actual_bucket_ms
        if source_interval == mapper.interval
        else mapper.actual_bucket_end(last_actual_bucket_ms) - source_interval_ms
    )
    source_gaps = _scan_bound_repository_gaps(
        repository=repository,
        snapshot=snapshot,
        config=config,
        interval=source_interval,
        interval_ms=source_interval_ms,
        start_ms=actual_scan_start_ms,
        end_ms=actual_scan_end_ms,
        source_revision_override=source_revision_override,
    )

    excluded_slots: list[tuple[int, int, set[str]]] = []
    for hole_start_ms, hole_end_ms in holes:
        public_bucket = compute_bucket_start_ms(
            hole_start_ms,
            mapper.interval_ms,
            interval=mapper.interval,
        )
        while public_bucket <= hole_end_ms:
            ordinal = mapper.public_bucket_ordinal(public_bucket)
            actual_bucket = mapper.actual_bucket_open(ordinal)
            actual_bucket_end = mapper.actual_bucket_end(actual_bucket)
            reasons = set()
            for gap_start_ms, gap_end_ms, reason in source_gaps:
                gap_end_exclusive_ms = (
                    mapper.actual_bucket_end(gap_end_ms)
                    if source_interval == mapper.interval
                    else gap_end_ms + source_interval_ms
                )
                if (
                    gap_start_ms < actual_bucket_end
                    and gap_end_exclusive_ms > actual_bucket
                ):
                    reasons.add(reason)
            public_bucket_end = mapper.public_bucket_end(public_bucket)
            slot_start = max(hole_start_ms, public_bucket)
            slot_end = min(hole_end_ms, public_bucket_end - 1)
            if not reasons:
                raise _fail(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "history page contains an undeclared source gap",
                    status_code=503,
                )
            excluded_slots.append((slot_start, slot_end, reasons))
            public_bucket = public_bucket_end

    merged: list[tuple[int, int, set[str]]] = []
    for start_ms, end_ms, reasons in excluded_slots:
        if merged and merged[-1][1] + 1 == start_ms:
            previous_start, _, previous_reasons = merged[-1]
            merged[-1] = (
                previous_start,
                end_ms,
                previous_reasons | reasons,
            )
        else:
            merged.append((start_ms, end_ms, set(reasons)))
    return tuple(
        _HistoryExcludedRange(
            start_ms=start_ms,
            end_ms=end_ms,
            reason="source_gap_affected_display_bucket",
            source_reason=(
                next(iter(reasons)) if len(reasons) == 1 else "multiple_source_gaps"
            ),
        )
        for start_ms, end_ms, reasons in merged
    )


def _resolve_native_display_context(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    actual_replay_start_ms: int,
    display_source_revision: str | None = None,
    display_source_bucket_anchor_ms: int | None = None,
    display_alignment_policy: str | None = None,
) -> _NativeDisplayHistoryContext | None:
    """Bind chart-only context to the stored display series when it is longer.

    Blind replay shifts the base timeline by an arbitrary number of minutes.
    Native display candles therefore cannot preserve both their real exchange
    bucket and that shifted public bucket.  Context is mapped ordinally onto
    complete public display slots, and the one native bucket touching the
    replay seam remains excluded.  The replay-owned base prefix is authoritative
    at and after that seam.
    """

    if config.display_interval == config.base_interval:
        return None
    if (
        snapshot.provenance.source_revision is not None
        and display_source_revision is None
    ):
        # A revision-bound base archive may use native display history only
        # after that display catalog has itself been immutably pinned.
        return None
    display_interval_ms = parse_interval_ms(config.display_interval)
    if display_interval_ms is None or display_interval_ms < 1:
        return None
    try:
        if display_source_revision is not None:
            get_bounds_at_revision = getattr(
                repository,
                "get_bounds_at_revision",
                None,
            )
            if not callable(get_bounds_at_revision):
                raise RuntimeError("native display revision reader is unavailable")
            bounds = get_bounds_at_revision(
                display_source_revision,
                config.symbol,
                config.display_interval,
                exchange=config.exchange,
                market_type=config.market_type,
            )
            if bounds.get("source_revision") not in {
                None,
                display_source_revision,
            }:
                raise RuntimeError("native display revision changed")
        else:
            bounds = repository.get_bounds(
                config.symbol,
                config.display_interval,
                exchange=config.exchange,
                market_type=config.market_type,
            )
    except Exception as exc:
        if display_source_revision is not None:
            raise _fail(
                "HISTORY_SOURCE_UNAVAILABLE",
                "pinned native display history is unavailable",
                status_code=503,
            ) from exc
        # The immutable base snapshot remains a valid fallback when the local
        # display series is absent or its optional bounds lookup is unavailable.
        return None
    earliest_open_ms = _safe_bound(bounds.get("earliest_open_time"))
    latest_open_ms = _safe_bound(bounds.get("latest_open_time"))
    raw_source_bucket_anchor_ms = bounds.get("source_bucket_anchor_ms")
    raw_alignment_policy = bounds.get("alignment_policy")
    source_bucket_anchor_ms = (
        None
        if raw_source_bucket_anchor_ms is None
        else (
            raw_source_bucket_anchor_ms
            if isinstance(raw_source_bucket_anchor_ms, int)
            and not isinstance(raw_source_bucket_anchor_ms, bool)
            else None
        )
    )
    if raw_source_bucket_anchor_ms is not None and source_bucket_anchor_ms is None:
        if display_source_revision is not None:
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "pinned native display grid is invalid",
                status_code=503,
            )
        return None
    if display_source_revision is not None and (
        source_bucket_anchor_ms != display_source_bucket_anchor_ms
        or not isinstance(raw_alignment_policy, str)
        or raw_alignment_policy != display_alignment_policy
    ):
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "pinned native display grid changed",
            status_code=503,
        )
    try:
        mapper = SourceBucketTimeMapper.create(
            interval=config.display_interval,
            actual_replay_start_ms=actual_replay_start_ms,
            public_replay_start_ms=snapshot.replay_start_ms,
            source_bucket_anchor_ms=source_bucket_anchor_ms,
        )
        last_complete_open_ms = mapper.actual_bucket_open(-1)
        if earliest_open_ms is not None:
            mapper.actual_bucket_ordinal(earliest_open_ms)
        if latest_open_ms is not None:
            mapper.actual_bucket_ordinal(latest_open_ms)
    except ValueError as exc:
        if display_source_revision is not None:
            raise _fail(
                "HISTORY_POLICY_INVALID",
                "pinned native display bucket mapping is invalid",
                status_code=503,
            ) from exc
        return None
    if last_complete_open_ms < 0:
        return None
    if (
        earliest_open_ms is None
        or latest_open_ms is None
        or earliest_open_ms > last_complete_open_ms
        or latest_open_ms < last_complete_open_ms
    ):
        if display_source_revision is not None:
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "pinned native display bounds are incomplete",
                status_code=503,
            )
        return None

    # Native history and source-bucket reconstruction must use the same
    # source-phase-preserving ordinal map. Blind public time can begin at a
    # different phase within the display bucket; independently flooring the
    # two origins shifts the native listing boundary and creates a false gap.
    actual_boundary_ms = earliest_open_ms
    public_boundary_ms = mapper.public_from_actual(actual_boundary_ms)
    while public_boundary_ms < 0:
        actual_boundary_ms = mapper.actual_bucket_end(actual_boundary_ms)
        public_boundary_ms = mapper.public_from_actual(actual_boundary_ms)
    if actual_boundary_ms > last_complete_open_ms:
        if display_source_revision is not None:
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "pinned native display history does not reach the replay seam",
                status_code=503,
            )
        return None
    return _NativeDisplayHistoryContext(
        mapper=mapper,
        actual_boundary_ms=actual_boundary_ms,
        public_boundary_ms=public_boundary_ms,
        source_revision=display_source_revision,
    )


def _build_native_display_page(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    context: _NativeDisplayHistoryContext,
    before_ms: int,
    revealed_boundary_ms: int,
    limit: int,
    actual_replay_start_ms: int,
) -> _HistoryPageResult:
    """Read complete native display candles without extending execution data."""

    mapper = context.mapper
    revealed_end_ms = compute_bucket_start_ms(
        revealed_boundary_ms + 1,
        mapper.interval_ms,
        interval=config.display_interval,
    )
    public_end_ms = min(
        before_ms,
        mapper.public_anchor_ms,
        revealed_end_ms,
    )
    try:
        actual_end_ms = mapper.actual_from_public(public_end_ms)
    except ValueError as exc:
        raise _fail(
            "HISTORY_CURSOR_INVALID",
            "training display history cursor is not interval aligned",
        ) from exc
    if public_end_ms <= context.public_boundary_ms:
        return _HistoryPageResult((), before_ms, False)
    last_requested_open_ms = mapper.actual_containing_bucket_open(actual_end_ms - 1)
    if last_requested_open_ms < context.actual_boundary_ms:
        return _HistoryPageResult((), before_ms, False)
    try:
        raw_rows = _query_bound_repository(
            repository,
            snapshot,
            config.symbol,
            config.display_interval,
            start_ms=context.actual_boundary_ms,
            end_ms=last_requested_open_ms,
            limit=limit + 1,
            order="DESC",
            exchange=config.exchange,
            market_type=config.market_type,
            source_revision_override=context.source_revision,
        )
    except TrainingRunError:
        raise
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "replay display history source could not be read",
            status_code=503,
        ) from exc

    validated_rows = []
    previous_open_ms = actual_end_ms
    try:
        for raw in raw_rows:
            raw_open_ms = int(raw["open_time"])
            mapper.actual_bucket_ordinal(raw_open_ms)
            if (
                raw_open_ms >= previous_open_ms
                or raw_open_ms < context.actual_boundary_ms
            ):
                raise ValueError("native history ordering is invalid")
            validated_rows.append(
                validate_replay_repository_bar(
                    raw,
                    identity=snapshot.identity,
                    interval=config.display_interval,
                    interval_ms=mapper.interval_ms,
                    expected_open_ms=raw_open_ms,
                    now_ms=actual_replay_start_ms,
                    expected_close_ms=mapper.actual_bucket_end(raw_open_ms) - 1,
                )
            )
            previous_open_ms = raw_open_ms
    except (KeyError, TypeError, ValueError, ReplayDomainError) as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay display history changed inside the bound source range",
            status_code=503,
        ) from exc

    if not validated_rows:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay display history query omitted the bound source range",
            status_code=503,
        )
    if (
        len(validated_rows) <= limit
        and validated_rows
        and validated_rows[-1].open_time_ms > context.actual_boundary_ms
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay display history query omitted older source rows",
            status_code=503,
        )

    selected = validated_rows[:limit]
    base_interval_ms = parse_interval_ms(config.base_interval)
    if base_interval_ms is None or base_interval_ms < 1:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training base interval is invalid",
            status_code=503,
        )
    page = []
    for row in reversed(selected):
        page.append(
            _native_row_to_display_bar(
                row,
                mapper=mapper,
                base_interval_ms=base_interval_ms,
            )
        )
    has_more = len(validated_rows) > limit
    next_before_ms = page[0].open_time_ms if page else before_ms
    excluded_ranges = _declared_source_bucket_exclusions(
        repository=repository,
        snapshot=snapshot,
        config=config,
        bars=page,
        connection_before_ms=public_end_ms,
        mapper=mapper,
        source_interval=config.display_interval,
        source_interval_ms=mapper.interval_ms,
        source_revision_override=context.source_revision,
    )
    return _HistoryPageResult(
        tuple(page),
        next_before_ms,
        has_more,
        excluded_ranges,
    )


def _native_row_to_display_bar(
    row: ReplayBar,
    *,
    mapper: SourceBucketTimeMapper,
    base_interval_ms: int,
) -> ReplayDisplayBar:
    """Project one fully revealed native candle onto the public timeline."""

    public_open_ms = mapper.public_from_actual(row.open_time_ms)
    public_close_ms = mapper.public_bucket_end(public_open_ms) - 1
    expected_components = max(
        1,
        (public_close_ms - public_open_ms + 1) // base_interval_ms,
    )
    return ReplayDisplayBar(
        open_time_ms=public_open_ms,
        close_time_ms=public_close_ms,
        open=row.open,
        high=row.high,
        low=row.low,
        close=row.close,
        volume=row.volume,
        quote_volume=row.quote_volume,
        trades=row.trades,
        taker_buy_base=row.taker_buy_base,
        taker_buy_quote=row.taker_buy_quote,
        first_base_open_ms=public_open_ms,
        last_base_open_ms=public_close_ms - base_interval_ms + 1,
        component_count=expected_components,
        expected_components=expected_components,
        is_closed=True,
        synthetic=False,
    )


def _bucket_overlaps_verified_halt(
    bucket_start_ms: int,
    bucket_end_ms: int,
    verified_halts: tuple[ReplayBarHalt, ...],
) -> bool:
    return any(
        halt.start_open_ms < bucket_end_ms and halt.resume_ms > bucket_start_ms
        for halt in verified_halts
    )


def _build_verified_halt_projection_bucket(
    *,
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
    config: ReplaySessionConfig,
    mapper: SourceBucketTimeMapper,
    verified_halts: tuple[ReplayBarHalt, ...],
    actual_bucket_open_ms: int,
    actual_end_ms: int,
    actual_replay_start_ms: int,
) -> ReplayDisplayBar | None:
    """Rebuild one halt-overlapping bucket from its exact traded components."""

    base_interval_ms = parse_interval_ms(config.base_interval)
    if base_interval_ms is None or base_interval_ms < 1:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training base interval is invalid",
            status_code=503,
        )
    actual_bucket_end_ms = mapper.actual_bucket_end(actual_bucket_open_ms)
    schedule = ReplayBarSchedule(config.base_interval, verified_halts)
    try:
        expected_count, first_open_ms, last_open_ms = schedule.expected_bounds(
            actual_bucket_open_ms,
            actual_bucket_end_ms,
        )
    except ReplayDomainError as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "verified halt projection schedule is invalid",
            status_code=503,
        ) from exc
    if expected_count == 0:
        return None
    if (
        first_open_ms is None
        or last_open_ms is None
        or expected_count > MAX_HISTORY_QUERY_BASE_ROWS
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "verified halt projection bucket exceeds the bounded source policy",
            status_code=503,
        )

    try:
        raw_rows = _query_bound_repository(
            repository,
            snapshot,
            config.symbol,
            config.base_interval,
            start_ms=first_open_ms,
            end_ms=last_open_ms,
            limit=expected_count,
            order="ASC",
            exchange=config.exchange,
            market_type=config.market_type,
        )
    except TrainingRunError:
        raise
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "verified halt projection source could not be read",
            status_code=503,
        ) from exc
    if len(raw_rows) != expected_count:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "verified halt projection omitted a traded base interval",
            status_code=503,
        )

    replay_rows: list[ReplayBar] = []
    try:
        for index, raw in enumerate(raw_rows):
            expected_open_ms = schedule.nth_expected_open(first_open_ms, index)
            raw_open_ms = int(raw["open_time"])
            replay_rows.append(
                validate_replay_repository_bar(
                    raw,
                    identity=snapshot.identity,
                    interval=config.base_interval,
                    interval_ms=base_interval_ms,
                    expected_open_ms=expected_open_ms,
                    now_ms=actual_end_ms,
                    expected_close_ms=expected_open_ms + base_interval_ms - 1,
                )
            )
            if raw_open_ms != expected_open_ms:
                raise ValueError("verified halt projection ordering changed")

        builder = ReplayBarBuilder(
            base_interval=config.base_interval,
            display_interval=config.display_interval,
            replay_start_ms=first_open_ms,
            max_closed_bars=1,
            verified_halts=verified_halts,
        )
        for replay_bar in replay_rows:
            builder.apply_bar(replay_bar)
    except (KeyError, TypeError, ValueError, ReplayDomainError) as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "verified halt projection base series changed",
            status_code=503,
        ) from exc
    if builder.active_bar is not None or len(builder.closed_bars) != 1:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "verified halt projection bucket did not close exactly",
            status_code=503,
        )

    rebuilt = builder.closed_bars[0]
    if rebuilt.open_time_ms != actual_bucket_open_ms:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "verified halt projection escaped its source bucket",
            status_code=503,
        )
    public_open_ms = mapper.public_from_actual(actual_bucket_open_ms)
    timeline_delta_ms = snapshot.replay_start_ms - actual_replay_start_ms
    return replace(
        rebuilt,
        open_time_ms=public_open_ms,
        close_time_ms=mapper.public_bucket_end(public_open_ms) - 1,
        first_base_open_ms=rebuilt.first_base_open_ms + timeline_delta_ms,
        last_base_open_ms=rebuilt.last_base_open_ms + timeline_delta_ms,
    )


def _replace_closed_projection_buckets_from_native(
    *,
    repository: KlinesReadRepository,
    snapshot: BarDatasetSnapshot,
    config: ReplaySessionConfig,
    mapper: SourceBucketTimeMapper,
    display_source_revision: str | None,
    actual_end_ms: int,
    actual_replay_start_ms: int,
    limit: int,
    bars: list[ReplayDisplayBar],
    verified_halts: tuple[ReplayBarHalt, ...] = (),
) -> list[ReplayDisplayBar]:
    """Use the immutable native display series for every closed bucket.

    Base history can contain a declared exchange gap inside an otherwise valid
    coarse bucket.  In that case source-bucket aggregation correctly refuses
    to fabricate the candle, but dropping the whole bucket creates a false
    chart seam.  Base aggregation can also differ from the exchange's native
    quote precision by a final rounding unit.  Once (and only once) a bucket is
    fully revealed, its pinned native exchange candle is authoritative and safe
    to project.  The still-forming bucket remains base-derived.
    """

    if display_source_revision is None or actual_end_ms <= mapper.actual_anchor_ms:
        return bars
    base_interval_ms = parse_interval_ms(config.base_interval)
    if base_interval_ms is None or base_interval_ms < 1:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training base interval is invalid",
            status_code=503,
        )

    last_observed_open_ms = mapper.actual_containing_bucket_open(actual_end_ms - 1)
    last_observed_ordinal = mapper.actual_bucket_ordinal(last_observed_open_ms)
    last_closed_ordinal = last_observed_ordinal
    if mapper.actual_bucket_end(last_observed_open_ms) > actual_end_ms:
        last_closed_ordinal -= 1
    if last_closed_ordinal < 0:
        return bars

    # Match the bounded tail window used by the base aggregate query.  This
    # keeps every projection request O(limit), even late in a long replay.
    first_candidate_ordinal = max(0, last_observed_ordinal - limit)
    existing_by_ordinal: dict[int, ReplayDisplayBar] = {}
    try:
        for bar in bars:
            ordinal = mapper.public_bucket_ordinal(bar.open_time_ms)
            if ordinal < 0 or ordinal in existing_by_ordinal:
                raise ValueError("projection bucket ordering is invalid")
            existing_by_ordinal[ordinal] = bar
    except ValueError as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "training display projection buckets are invalid",
            status_code=503,
        ) from exc

    candidate_ordinals = list(range(first_candidate_ordinal, last_closed_ordinal + 1))
    first_candidate_open_ms = mapper.actual_bucket_open(candidate_ordinals[0])
    last_candidate_open_ms = mapper.actual_bucket_open(candidate_ordinals[-1])
    query_limit = len(candidate_ordinals)
    try:
        raw_rows = _query_bound_repository(
            repository,
            snapshot,
            config.symbol,
            config.display_interval,
            start_ms=first_candidate_open_ms,
            end_ms=last_candidate_open_ms,
            limit=query_limit,
            order="ASC",
            exchange=config.exchange,
            market_type=config.market_type,
            source_revision_override=display_source_revision,
        )
    except TrainingRunError:
        raise
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "pinned native display projection source could not be read",
            status_code=503,
        ) from exc

    candidate_set = set(candidate_ordinals)
    halt_ordinals = {
        ordinal
        for ordinal in candidate_ordinals
        if _bucket_overlaps_verified_halt(
            mapper.actual_bucket_open(ordinal),
            mapper.actual_bucket_end(mapper.actual_bucket_open(ordinal)),
            verified_halts,
        )
    }
    replaced_ordinals: set[int] = set()
    previous_open_ms: int | None = None
    try:
        for raw in raw_rows:
            raw_open_ms = int(raw["open_time"])
            ordinal = mapper.actual_bucket_ordinal(raw_open_ms)
            if (
                ordinal < candidate_ordinals[0]
                or ordinal > candidate_ordinals[-1]
                or (previous_open_ms is not None and raw_open_ms <= previous_open_ms)
            ):
                raise ValueError("native projection ordering is invalid")
            row = validate_replay_repository_bar(
                raw,
                identity=snapshot.identity,
                interval=config.display_interval,
                interval_ms=mapper.interval_ms,
                expected_open_ms=raw_open_ms,
                now_ms=actual_end_ms,
                expected_close_ms=mapper.actual_bucket_end(raw_open_ms) - 1,
            )
            if ordinal in candidate_set and ordinal not in halt_ordinals:
                existing_by_ordinal[ordinal] = _native_row_to_display_bar(
                    row,
                    mapper=mapper,
                    base_interval_ms=base_interval_ms,
                )
                replaced_ordinals.add(ordinal)
            previous_open_ms = raw_open_ms
    except (KeyError, TypeError, ValueError, ReplayDomainError) as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "pinned native display projection changed inside the bound source range",
            status_code=503,
        ) from exc

    for ordinal in sorted(halt_ordinals):
        actual_bucket_open_ms = mapper.actual_bucket_open(ordinal)
        rebuilt = _build_verified_halt_projection_bucket(
            repository=repository,
            snapshot=snapshot,
            config=config,
            mapper=mapper,
            verified_halts=verified_halts,
            actual_bucket_open_ms=actual_bucket_open_ms,
            actual_end_ms=actual_end_ms,
            actual_replay_start_ms=actual_replay_start_ms,
        )
        if rebuilt is None:
            existing_by_ordinal.pop(ordinal, None)
        else:
            existing_by_ordinal[ordinal] = rebuilt
        replaced_ordinals.add(ordinal)

    omitted_ordinals = candidate_set - replaced_ordinals
    if omitted_ordinals:
        # Projection v1 has no excluded-range channel.  Returning a silent
        # hole would recreate the chart corruption this fallback prevents, so
        # a real native maintenance gap remains explicit and fail-closed.
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "pinned native display projection omitted a closed bucket",
            status_code=503,
        )

    return [existing_by_ordinal[key] for key in sorted(existing_by_ordinal)]


def _query_validated_descending_base_rows(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    actual_start_ms: int,
    actual_end_ms: int,
    interval_ms: int,
    query_limit: int,
    validation_now_ms: int,
) -> list[ReplayBar]:
    try:
        raw_rows = _query_bound_repository(
            repository,
            snapshot,
            config.symbol,
            config.base_interval,
            start_ms=actual_start_ms,
            end_ms=actual_end_ms - interval_ms,
            limit=query_limit,
            order="DESC",
            exchange=config.exchange,
            market_type=config.market_type,
        )
    except TrainingRunError:
        raise
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "replay history source could not be read",
            status_code=503,
        ) from exc
    validated = []
    previous_open_ms = actual_end_ms
    try:
        for raw in raw_rows:
            raw_open_ms = int(raw["open_time"])
            if (
                raw_open_ms >= previous_open_ms
                or raw_open_ms < actual_start_ms
                or compute_bucket_start_ms(
                    raw_open_ms,
                    interval_ms,
                    interval=config.base_interval,
                )
                != raw_open_ms
            ):
                raise ValueError("base history ordering is invalid")
            validated.append(
                validate_replay_repository_bar(
                    raw,
                    identity=snapshot.identity,
                    interval=config.base_interval,
                    interval_ms=interval_ms,
                    expected_open_ms=raw_open_ms,
                    now_ms=validation_now_ms,
                )
            )
            previous_open_ms = raw_open_ms
    except (KeyError, TypeError, ValueError, ReplayDomainError) as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history source changed inside the bound source range",
            status_code=503,
        ) from exc
    if not validated:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history query omitted the bound source range",
            status_code=503,
        )
    if (
        len(validated) < query_limit
        and validated
        and validated[-1].open_time_ms > actual_start_ms
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history query omitted older source rows",
            status_code=503,
        )
    return validated


def _display_bar_from_base_row(
    row: ReplayBar,
    *,
    timeline_delta_ms: int,
) -> ReplayDisplayBar:
    open_time_ms = row.open_time_ms + timeline_delta_ms
    close_time_ms = row.close_time_ms + timeline_delta_ms
    return ReplayDisplayBar(
        open_time_ms=open_time_ms,
        close_time_ms=close_time_ms,
        open=row.open,
        high=row.high,
        low=row.low,
        close=row.close,
        volume=row.volume,
        quote_volume=row.quote_volume,
        trades=row.trades,
        taker_buy_base=row.taker_buy_base,
        taker_buy_quote=row.taker_buy_quote,
        first_base_open_ms=open_time_ms,
        last_base_open_ms=open_time_ms,
        component_count=1,
        expected_components=1,
        is_closed=True,
        synthetic=False,
    )


def _build_base_interval_page(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    before_ms: int,
    actual_start_ms: int,
    actual_end_ms: int,
    interval_ms: int,
    timeline_delta_ms: int,
    limit: int,
) -> _HistoryPageResult:
    validated = _query_validated_descending_base_rows(
        repository=repository,
        config=config,
        snapshot=snapshot,
        actual_start_ms=actual_start_ms,
        actual_end_ms=actual_end_ms,
        interval_ms=interval_ms,
        query_limit=limit + 1,
        validation_now_ms=actual_end_ms,
    )
    selected = validated[:limit]
    page = [
        _display_bar_from_base_row(
            row,
            timeline_delta_ms=timeline_delta_ms,
        )
        for row in reversed(selected)
    ]
    public_end_ms = actual_end_ms + timeline_delta_ms
    exclusions = _declared_page_exclusions(
        repository=repository,
        snapshot=snapshot,
        config=config,
        bars=page,
        connection_before_ms=public_end_ms,
        timeline_delta_ms=timeline_delta_ms,
        source_interval=config.base_interval,
        source_interval_ms=interval_ms,
    )
    return _HistoryPageResult(
        tuple(page),
        page[0].open_time_ms if page else before_ms,
        len(validated) > limit,
        exclusions,
    )


def _aggregate_contiguous_base_segments(
    *,
    rows: list[ReplayBar],
    config: ReplaySessionConfig,
    interval_ms: int,
) -> list[ReplayDisplayBar]:
    segments: list[list[ReplayBar]] = []
    for row in rows:
        if (
            not segments
            or row.open_time_ms != segments[-1][-1].open_time_ms + interval_ms
        ):
            segments.append([row])
        else:
            segments[-1].append(row)
    bars: list[ReplayDisplayBar] = []
    display_interval_ms = parse_interval_ms(config.display_interval)
    if display_interval_ms is None:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training display interval is invalid",
            status_code=503,
        )
    try:
        for segment in segments:
            aligned_start = next(
                (
                    index
                    for index, row in enumerate(segment)
                    if compute_bucket_start_ms(
                        row.open_time_ms,
                        display_interval_ms,
                        interval=config.display_interval,
                    )
                    == row.open_time_ms
                ),
                None,
            )
            if aligned_start is None:
                continue
            aligned = segment[aligned_start:]
            builder = ReplayBarBuilder(
                base_interval=config.base_interval,
                display_interval=config.display_interval,
                replay_start_ms=aligned[-1].close_time_ms + 1,
                warmup_bars=aligned,
                max_closed_bars=max(1, len(aligned)),
            )
            bars.extend(builder.closed_bars)
    except ReplayDomainError as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history source cannot reconstruct declared source segments",
            status_code=503,
        ) from exc
    bars.sort(key=lambda bar: bar.open_time_ms)
    return bars


def _build_gapped_aggregate_page(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    before_ms: int,
    revealed_boundary_ms: int,
    history_boundary_ms: int,
    actual_start_ms: int,
    actual_end_ms: int,
    interval_ms: int,
    timeline_delta_ms: int,
    limit: int,
) -> _HistoryPageResult:
    display_interval_ms = parse_interval_ms(config.display_interval)
    if display_interval_ms is None:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training display interval is invalid",
            status_code=503,
        )
    components_per_display = max(
        1,
        (display_interval_ms + interval_ms - 1) // interval_ms,
    )
    query_limit = min(
        MAX_HISTORY_QUERY_BASE_ROWS,
        max(
            components_per_display * 2,
            (limit + 5) * components_per_display,
        ),
    )
    descending = _query_validated_descending_base_rows(
        repository=repository,
        config=config,
        snapshot=snapshot,
        actual_start_ms=actual_start_ms,
        actual_end_ms=actual_end_ms,
        interval_ms=interval_ms,
        query_limit=query_limit,
        validation_now_ms=actual_end_ms,
    )
    actual_rows = list(reversed(descending))
    public_rows = (
        actual_rows
        if timeline_delta_ms == 0
        else [
            replace(
                row,
                open_time_ms=row.open_time_ms + timeline_delta_ms,
                close_time_ms=row.close_time_ms + timeline_delta_ms,
            )
            for row in actual_rows
        ]
    )
    aggregated = _aggregate_contiguous_base_segments(
        rows=public_rows,
        config=config,
        interval_ms=interval_ms,
    )
    eligible = [
        bar
        for bar in aggregated
        if bar.open_time_ms >= history_boundary_ms
        and bar.open_time_ms < before_ms
        and bar.close_time_ms <= revealed_boundary_ms
        and bar.last_base_open_ms <= revealed_boundary_ms
    ]
    page = eligible[-limit:]
    source_has_more = bool(descending and descending[-1].open_time_ms > actual_start_ms)
    has_more = source_has_more or len(eligible) > len(page)
    if not page and has_more:
        raise _fail(
            "HISTORY_PAGE_INTERVAL_TOO_LARGE",
            "display interval cannot form a complete gap-aware history page",
            status_code=409,
        )
    public_end_ms = actual_end_ms + timeline_delta_ms
    exclusions = _declared_page_exclusions(
        repository=repository,
        snapshot=snapshot,
        config=config,
        bars=page,
        connection_before_ms=public_end_ms,
        timeline_delta_ms=timeline_delta_ms,
        source_interval=config.base_interval,
        source_interval_ms=interval_ms,
    )
    return _HistoryPageResult(
        tuple(page),
        page[0].open_time_ms if page else before_ms,
        has_more,
        exclusions,
    )


def _build_all_available_page(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    before_ms: int,
    revealed_boundary_ms: int,
    limit: int,
    history_boundary_ms: int,
    actual_history_start_ms: int,
    actual_replay_start_ms: int,
    interval_ms: int,
) -> _HistoryPageResult:
    """Read one bounded chart page without expanding the execution snapshot."""

    timeline_delta_ms = snapshot.replay_start_ms - actual_replay_start_ms
    # The immutable ALL_AVAILABLE source remains chart-readable after the
    # execution snapshot's bounded bar builder evicts older replay rows.  Page
    # through every fully revealed source row, while keeping the request
    # exclusive and clamped to the durable public cursor.
    public_end_ms = min(before_ms, revealed_boundary_ms + 1)
    actual_end_ms = public_end_ms - timeline_delta_ms
    actual_end_ms = compute_bucket_start_ms(
        actual_end_ms,
        interval_ms,
        interval=config.base_interval,
    )
    public_end_ms = actual_end_ms + timeline_delta_ms
    if actual_end_ms <= actual_history_start_ms:
        return _HistoryPageResult((), before_ms, False)
    distance_ms = actual_end_ms - actual_history_start_ms
    if distance_ms % interval_ms:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history boundary is not base-interval aligned",
            status_code=503,
        )

    display_interval_ms = parse_interval_ms(config.display_interval)
    if display_interval_ms is None or display_interval_ms < interval_ms:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training display interval is invalid",
            status_code=503,
        )
    if display_interval_ms == interval_ms:
        return _build_base_interval_page(
            repository=repository,
            config=config,
            snapshot=snapshot,
            before_ms=before_ms,
            actual_start_ms=actual_history_start_ms,
            actual_end_ms=actual_end_ms,
            interval_ms=interval_ms,
            timeline_delta_ms=timeline_delta_ms,
            limit=limit,
        )
    source_revision = snapshot.provenance.source_revision
    query_source_buckets = getattr(
        repository,
        "query_source_bucket_bars_at_revision",
        None,
    )
    can_use_source_bucket_aggregate = (
        source_revision is not None
        and callable(query_source_buckets)
        and display_interval_ms > interval_ms
        and (
            is_monthly_interval(config.display_interval)
            or display_interval_ms % interval_ms == 0
        )
    )
    if can_use_source_bucket_aggregate:
        try:
            mapper = SourceBucketTimeMapper.create(
                interval=config.display_interval,
                actual_replay_start_ms=actual_replay_start_ms,
                public_replay_start_ms=snapshot.replay_start_ms,
            )
            public_before_bucket = compute_bucket_start_ms(
                before_ms,
                display_interval_ms,
                interval=config.display_interval,
            )
            actual_before_ms = mapper.actual_from_public(public_before_bucket)
        except ValueError as exc:
            raise _fail(
                "HISTORY_CURSOR_INVALID",
                "training display history cursor is not interval aligned",
            ) from exc
        actual_revealed_end_ms = (
            actual_replay_start_ms + revealed_boundary_ms + 1 - snapshot.replay_start_ms
        )
        revealed_complete_end_ms = compute_bucket_start_ms(
            actual_revealed_end_ms,
            display_interval_ms,
            interval=config.display_interval,
        )
        aggregate_actual_end_ms = min(
            actual_before_ms,
            revealed_complete_end_ms,
        )
        if aggregate_actual_end_ms <= actual_history_start_ms:
            return _HistoryPageResult((), before_ms, False)
        aggregate_public_end_ms = mapper.public_from_actual(aggregate_actual_end_ms)
        try:
            aggregated = query_source_buckets(
                source_revision,
                config.symbol,
                config.base_interval,
                config.display_interval,
                actual_start_ms=actual_history_start_ms,
                actual_end_ms=aggregate_actual_end_ms,
                actual_replay_start_ms=actual_replay_start_ms,
                public_replay_start_ms=snapshot.replay_start_ms,
                limit=limit,
                exchange=config.exchange,
                market_type=config.market_type,
            )
            raw_bars = aggregated["bars"]
            aggregate_has_more = aggregated["has_more"]
            if not isinstance(raw_bars, list) or not isinstance(
                aggregate_has_more,
                bool,
            ):
                raise TypeError("aggregate history result is invalid")
            aggregate_bars = [
                ReplayDisplayBar.from_dict(raw)
                for raw in raw_bars
                if isinstance(raw, Mapping)
            ]
            if len(aggregate_bars) != len(raw_bars):
                raise TypeError("aggregate history bars are invalid")
        except Exception as exc:
            raise _fail(
                "HISTORY_SOURCE_UNAVAILABLE",
                "replay history source could not be aggregated",
                status_code=503,
            ) from exc
        eligible = [
            bar
            for bar in aggregate_bars
            if bar.open_time_ms >= history_boundary_ms
            and bar.open_time_ms < before_ms
            and bar.close_time_ms <= revealed_boundary_ms
            and bar.last_base_open_ms <= revealed_boundary_ms
        ]
        page = eligible[-limit:]
        has_more = aggregate_has_more or len(eligible) > len(page)
        if not page and has_more:
            raise _fail(
                "HISTORY_PAGE_INTERVAL_TOO_LARGE",
                "display interval cannot form a complete gap-aware history page",
                status_code=409,
            )
        next_before_ms = page[0].open_time_ms if page else before_ms
        exclusions = _declared_source_bucket_exclusions(
            repository=repository,
            snapshot=snapshot,
            config=config,
            bars=page,
            connection_before_ms=aggregate_public_end_ms,
            mapper=mapper,
            source_interval=config.base_interval,
            source_interval_ms=interval_ms,
        )
        return _HistoryPageResult(
            tuple(page),
            next_before_ms,
            has_more,
            exclusions,
        )

    return _build_gapped_aggregate_page(
        repository=repository,
        config=config,
        snapshot=snapshot,
        before_ms=before_ms,
        revealed_boundary_ms=revealed_boundary_ms,
        history_boundary_ms=history_boundary_ms,
        actual_start_ms=actual_history_start_ms,
        actual_end_ms=actual_end_ms,
        interval_ms=interval_ms,
        timeline_delta_ms=timeline_delta_ms,
        limit=limit,
    )


def build_history_page(
    *,
    binding: Mapping[str, object],
    persisted: Mapping[str, object],
    before_ms: int,
    revealed_boundary_ms: int,
    limit: int,
    data_epoch: str,
    expected_history_epoch: str | None,
    display_interval: str | None = None,
    repository: KlinesReadRepository | None = None,
) -> dict[str, object]:
    for field_name, value in (
        ("before_ms", before_ms),
        ("revealed_boundary_ms", revealed_boundary_ms),
        ("limit", limit),
    ):
        if isinstance(value, bool) or not isinstance(value, int):
            raise _fail(
                "TRAINING_RUN_INVALID",
                f"{field_name} must be an integer",
                status_code=422,
            )
    if before_ms < 0 or revealed_boundary_ms < 0:
        raise _fail(
            "TRAINING_RUN_INVALID",
            "history timestamps cannot be negative",
            status_code=422,
        )
    if limit < 1 or limit > MAX_HISTORY_PAGE_BARS:
        raise _fail(
            "TRAINING_RUN_INVALID",
            "history page limit is out of range",
            status_code=422,
        )
    if binding.get("degraded_reason") is not None:
        raise _fail(
            "HISTORY_SNAPSHOT_UNAVAILABLE",
            "training history snapshot is unavailable",
            status_code=503,
        )

    epochs = {
        str(binding["track_dataset_epoch"]),
        str(binding["session_data_epoch"]),
        str(persisted.get("data_epoch")),
    }
    if binding["session_id"] == binding["primary_adapter_session_id"]:
        epochs.add(str(binding["run_dataset_epoch"]))
    if len(epochs) != 1 or data_epoch not in epochs:
        raise _fail(
            "HISTORY_DATA_EPOCH_MISMATCH",
            "training history data epoch does not match",
        )
    durable_boundary = int(binding["virtual_time_ms"])
    if revealed_boundary_ms > durable_boundary:
        raise _fail(
            "HISTORY_BOUNDARY_AHEAD",
            "requested history boundary is ahead of the durable replay cursor",
        )

    config_payload = binding.get("config")
    if not isinstance(config_payload, Mapping):
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training history source configuration is invalid",
            status_code=503,
        )
    try:
        config = ReplaySessionConfig.from_dict(config_payload)
    except (TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training history source configuration is invalid",
            status_code=503,
        ) from exc
    snapshot = _decode_bar_snapshot(persisted, config=config)
    requested_display_interval = (
        config.display_interval if display_interval is None else display_interval
    )
    if (
        not isinstance(requested_display_interval, str)
        or not requested_display_interval
    ):
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "training display history interval is invalid",
            status_code=422,
        )
    try:
        history_config = replace(
            config,
            display_interval=requested_display_interval,
        )
    except (TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "training display history interval is invalid",
            status_code=422,
        ) from exc
    identity = _assert_source_binding(
        binding,
        config,
        snapshot,
        display_interval=requested_display_interval,
    )
    raw_policy = binding.get("history_policy")
    if not isinstance(raw_policy, Mapping):
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is unavailable",
            status_code=503,
        )
    required_policy_fields = {
        "schema_version",
        "indicator_warmup_bars",
        "visible_history_lookback",
        "visible_history_rows",
        "actual_visible_history_start_ms",
        "actual_replay_start_ms",
        "effective_warmup_bars",
        "forward_cache_ms",
        "interval_ms",
        "policy_hash",
    }
    if set(raw_policy) != required_policy_fields:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is invalid",
            status_code=503,
        )
    history_mode = _history_mode(raw_policy)
    try:
        actual_replay_start_ms = int(raw_policy["actual_replay_start_ms"])
        actual_visible_history_start_ms = int(
            raw_policy["actual_visible_history_start_ms"]
        )
        interval_ms = int(raw_policy["interval_ms"])
    except (TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is invalid",
            status_code=503,
        ) from exc
    if interval_ms < 1:
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is invalid",
            status_code=503,
        )
    policy_hash = str(raw_policy["policy_hash"])
    if len(policy_hash) != 71 or not policy_hash.startswith("sha256:"):
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy commitment is invalid",
            status_code=503,
        )
    actual_history_start_ms = actual_visible_history_start_ms
    listing_boundary_source = "frozen_history_policy"
    if history_mode == "ALL_AVAILABLE" and repository is not None:
        (
            actual_history_start_ms,
            listing_boundary_source,
        ) = _bound_source_start_ms(
            repository=repository,
            config=history_config,
            snapshot=snapshot,
            actual_replay_start_ms=actual_replay_start_ms,
            fallback_start_ms=actual_visible_history_start_ms,
            interval_ms=interval_ms,
        )
    base_history_boundary_ms = (
        snapshot.replay_start_ms + actual_history_start_ms - actual_replay_start_ms
    )
    if (
        base_history_boundary_ms < 0
        or base_history_boundary_ms > snapshot.replay_start_ms
    ):
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history boundary is invalid",
            status_code=503,
        )
    display_interval_ms = parse_interval_ms(history_config.display_interval)
    source_bucket_mapper: SourceBucketTimeMapper | None = None
    if (
        history_mode == "ALL_AVAILABLE"
        and repository is not None
        and snapshot.provenance.source_revision is not None
        and display_interval_ms is not None
        and display_interval_ms > interval_ms
        and callable(
            getattr(
                repository,
                "query_source_bucket_bars_at_revision",
                None,
            )
        )
    ):
        try:
            source_bucket_mapper = SourceBucketTimeMapper.create(
                interval=history_config.display_interval,
                actual_replay_start_ms=actual_replay_start_ms,
                public_replay_start_ms=snapshot.replay_start_ms,
            )
        except ValueError as exc:
            raise _fail(
                "HISTORY_POLICY_INVALID",
                "training display bucket mapping is invalid",
                status_code=503,
            ) from exc
    raw_display_source_revision = binding.get("display_source_revision")
    if raw_display_source_revision is None:
        display_source_revision = None
    elif (
        not isinstance(raw_display_source_revision, str)
        or len(raw_display_source_revision) != 71
        or not raw_display_source_revision.startswith("sha256:")
        or any(
            character not in "0123456789abcdef"
            for character in raw_display_source_revision[7:]
        )
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "pinned native display revision is invalid",
            status_code=503,
        )
    else:
        display_source_revision = raw_display_source_revision
    (
        display_source_bucket_anchor_ms,
        display_alignment_policy,
        display_grid_commitment,
    ) = _validated_display_grid_binding(
        binding,
        display_interval=requested_display_interval,
        source_revision=display_source_revision,
    )
    native_context = (
        _resolve_native_display_context(
            repository=repository,
            config=history_config,
            snapshot=snapshot,
            actual_replay_start_ms=actual_replay_start_ms,
            display_source_revision=display_source_revision,
            display_source_bucket_anchor_ms=display_source_bucket_anchor_ms,
            display_alignment_policy=display_alignment_policy,
        )
        if history_mode == "ALL_AVAILABLE" and repository is not None
        else None
    )
    if (
        native_context is not None
        and native_context.source_revision is not None
        and native_context.public_boundary_ms > base_history_boundary_ms
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "pinned native display history starts after the base archive",
            status_code=503,
        )
    if (
        native_context is not None
        and native_context.public_boundary_ms <= base_history_boundary_ms
    ):
        history_boundary_ms = native_context.public_boundary_ms
        history_source: Mapping[str, object] = {
            "mode": "NATIVE_DISPLAY_CONTEXT",
            "display_interval": requested_display_interval,
            "public_boundary_ms": history_boundary_ms,
            "gap_policy": "DECLARED_SOURCE_GAPS_V1",
            "listing_boundary_source": listing_boundary_source,
            "source_revision": native_context.source_revision,
            "grid_commitment": display_grid_commitment,
            "seam_policy": "NATIVE_CLOSED_BEFORE_REPLAY_BASE_AT_OR_AFTER_V1",
        }
    elif source_bucket_mapper is not None:
        assert display_interval_ms is not None
        first_actual_bucket_ms = compute_bucket_start_ms(
            actual_history_start_ms,
            display_interval_ms,
            interval=history_config.display_interval,
        )
        if first_actual_bucket_ms < actual_history_start_ms:
            first_actual_bucket_ms = source_bucket_mapper.actual_bucket_end(
                first_actual_bucket_ms
            )
        history_boundary_ms = source_bucket_mapper.public_from_actual(
            first_actual_bucket_ms
        )
        while history_boundary_ms < 0:
            first_actual_bucket_ms = source_bucket_mapper.actual_bucket_end(
                first_actual_bucket_ms
            )
            history_boundary_ms = source_bucket_mapper.public_from_actual(
                first_actual_bucket_ms
            )
        if history_boundary_ms > snapshot.replay_start_ms:
            raise _fail(
                "HISTORY_POLICY_INVALID",
                "training display history boundary is invalid",
                status_code=503,
            )
        native_context = None
        history_source = {
            "mode": "SOURCE_NATIVE_BUCKET_RECONSTRUCTION",
            "display_interval": requested_display_interval,
            "public_boundary_ms": history_boundary_ms,
            "gap_policy": "DECLARED_SOURCE_GAPS_V1",
            "listing_boundary_source": listing_boundary_source,
        }
    else:
        native_context = None
        history_boundary_ms = base_history_boundary_ms
        history_source = {
            "mode": "FROZEN_BASE_RECONSTRUCTION",
            "display_interval": requested_display_interval,
            "public_boundary_ms": history_boundary_ms,
            "gap_policy": "DECLARED_SOURCE_GAPS_V1",
            "listing_boundary_source": listing_boundary_source,
        }
    history_epoch = _history_epoch(
        binding=binding,
        identity=identity,
        snapshot=snapshot,
        data_epoch=data_epoch,
        history_boundary_ms=history_boundary_ms,
        policy_hash=policy_hash,
        history_source=history_source,
    )
    if expected_history_epoch is not None and expected_history_epoch != history_epoch:
        raise _fail(
            "HISTORY_EPOCH_MISMATCH",
            "training history epoch does not match",
        )

    if history_mode == "ALL_AVAILABLE":
        if repository is None:
            raise _fail(
                "HISTORY_SOURCE_UNAVAILABLE",
                "replay history source is unavailable",
                status_code=503,
            )
        if native_context is not None:
            page_result = _build_native_display_page(
                repository=repository,
                config=history_config,
                snapshot=snapshot,
                context=native_context,
                before_ms=before_ms,
                revealed_boundary_ms=revealed_boundary_ms,
                limit=limit,
                actual_replay_start_ms=actual_replay_start_ms,
            )
        else:
            page_result = _build_all_available_page(
                repository=repository,
                config=history_config,
                snapshot=snapshot,
                before_ms=before_ms,
                revealed_boundary_ms=revealed_boundary_ms,
                limit=limit,
                history_boundary_ms=history_boundary_ms,
                actual_history_start_ms=actual_history_start_ms,
                actual_replay_start_ms=actual_replay_start_ms,
                interval_ms=interval_ms,
            )
    else:
        builder = ReplayBarBuilder(
            base_interval=history_config.base_interval,
            display_interval=history_config.display_interval,
            replay_start_ms=snapshot.replay_start_ms,
            warmup_bars=snapshot.warmup_rows,
            max_closed_bars=max(1, snapshot.row_count),
        )
        for replay_bar in snapshot.replay_rows:
            if replay_bar.close_time_ms > revealed_boundary_ms:
                break
            builder.apply_bar(replay_bar)

        eligible = [
            bar
            for bar in builder.closed_bars
            if bar.open_time_ms >= history_boundary_ms
            and bar.open_time_ms < before_ms
            and bar.close_time_ms <= revealed_boundary_ms
            and bar.last_base_open_ms <= revealed_boundary_ms
        ]
        page = eligible[-limit:]
        has_more = len(eligible) > len(page)
        next_before_ms = page[0].open_time_ms if page else before_ms
        page_result = _HistoryPageResult(
            tuple(page),
            next_before_ms,
            has_more,
        )
    return {
        "protocol": "replay.v2",
        "schema_version": HISTORY_SCHEMA_VERSION,
        "run_id": str(binding["run_id"]),
        "session_id": str(binding["session_id"]),
        "track_id": str(binding["track_id"]),
        "identity": identity,
        "data_epoch": data_epoch,
        "history_epoch": history_epoch,
        "history_boundary_ms": history_boundary_ms,
        "history_policy": {
            key: value
            for key, value in raw_policy.items()
            if key
            not in {
                "actual_visible_history_start_ms",
                "actual_replay_start_ms",
            }
        },
        "revealed_boundary_ms": revealed_boundary_ms,
        "bars": [bar.to_dict() for bar in page_result.bars],
        "excluded_ranges": [item.to_dict() for item in page_result.excluded_ranges],
        "next_before_ms": page_result.next_before_ms,
        "has_more": page_result.has_more,
    }


def build_display_projection(
    *,
    binding: Mapping[str, object],
    persisted: Mapping[str, object],
    revealed_boundary_ms: int,
    limit: int,
    data_epoch: str,
    display_interval: str,
    repository: KlinesReadRepository | None,
) -> dict[str, object]:
    """Build the revealed viewer tail from native source buckets.

    This response is chart-only.  It does not mutate the replay actor and it
    contains only synthetic public timestamps.
    """

    if (
        isinstance(revealed_boundary_ms, bool)
        or not isinstance(revealed_boundary_ms, int)
        or revealed_boundary_ms < 0
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > MAX_HISTORY_PAGE_BARS
        or not isinstance(display_interval, str)
        or not display_interval
    ):
        raise _fail(
            "TRAINING_RUN_INVALID",
            "display projection request is invalid",
            status_code=422,
        )
    if binding.get("degraded_reason") is not None:
        raise _fail(
            "HISTORY_SNAPSHOT_UNAVAILABLE",
            "training display projection is unavailable",
            status_code=503,
        )
    epochs = {
        str(binding["track_dataset_epoch"]),
        str(binding["session_data_epoch"]),
        str(persisted.get("data_epoch")),
    }
    if binding["session_id"] == binding["primary_adapter_session_id"]:
        epochs.add(str(binding["run_dataset_epoch"]))
    if len(epochs) != 1 or data_epoch not in epochs:
        raise _fail(
            "HISTORY_DATA_EPOCH_MISMATCH",
            "training display projection epoch does not match",
        )
    durable_boundary_ms = int(binding["virtual_time_ms"])
    if revealed_boundary_ms > durable_boundary_ms:
        raise _fail(
            "HISTORY_BOUNDARY_AHEAD",
            "requested display projection is ahead of the durable replay cursor",
        )
    config_payload = binding.get("config")
    if not isinstance(config_payload, Mapping):
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training display projection configuration is invalid",
            status_code=503,
        )
    try:
        config = ReplaySessionConfig.from_dict(config_payload)
        projection_config = replace(config, display_interval=display_interval)
    except (TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "training display projection interval is invalid",
            status_code=422,
        ) from exc
    snapshot = _decode_bar_snapshot(persisted, config=config)
    verified_halts = _decode_verified_market_halts(
        persisted,
        snapshot=snapshot,
        config=config,
    )
    identity = _assert_source_binding(
        binding,
        config,
        snapshot,
        display_interval=display_interval,
    )
    base_interval_ms = parse_interval_ms(config.base_interval)
    display_interval_ms = parse_interval_ms(display_interval)
    if (
        base_interval_ms is None
        or display_interval_ms is None
        or display_interval_ms <= base_interval_ms
        or (
            not is_monthly_interval(display_interval)
            and display_interval_ms % base_interval_ms
        )
    ):
        raise _fail(
            "HISTORY_SOURCE_IDENTITY_DRIFT",
            "training display projection interval is unsupported",
            status_code=422,
        )
    raw_display_source_revision = binding.get("display_source_revision")
    if raw_display_source_revision is None:
        display_source_revision = None
    elif (
        not isinstance(raw_display_source_revision, str)
        or len(raw_display_source_revision) != 71
        or not raw_display_source_revision.startswith("sha256:")
        or any(
            character not in "0123456789abcdef"
            for character in raw_display_source_revision[7:]
        )
    ):
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "pinned native display revision is invalid",
            status_code=503,
        )
    else:
        display_source_revision = raw_display_source_revision
    (
        display_source_bucket_anchor_ms,
        _display_alignment_policy,
        display_grid_commitment,
    ) = _validated_display_grid_binding(
        binding,
        display_interval=display_interval,
        source_revision=display_source_revision,
    )
    if repository is None or snapshot.provenance.source_revision is None:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "source-aligned display projection requires a revision-bound archive",
            status_code=503,
        )
    query_source_buckets = getattr(
        repository,
        "query_source_bucket_bars_at_revision",
        None,
    )
    if not callable(query_source_buckets):
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "source-aligned display projection is unavailable",
            status_code=503,
        )
    actual_replay_start_ms = persisted.get("actual_replay_start_ms")
    if (
        isinstance(actual_replay_start_ms, bool)
        or not isinstance(actual_replay_start_ms, int)
        or actual_replay_start_ms < 0
    ):
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training display projection source origin is invalid",
            status_code=503,
        )
    try:
        mapper = SourceBucketTimeMapper.create(
            interval=display_interval,
            actual_replay_start_ms=actual_replay_start_ms,
            public_replay_start_ms=snapshot.replay_start_ms,
            source_bucket_anchor_ms=display_source_bucket_anchor_ms,
        )
    except ValueError as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "training display projection grid is invalid",
            status_code=503,
        ) from exc
    actual_end_ms = (
        actual_replay_start_ms + revealed_boundary_ms + 1 - snapshot.replay_start_ms
    )
    no_revealed_bars = revealed_boundary_ms == snapshot.replay_start_ms
    if not no_revealed_bars and (
        actual_end_ms <= actual_replay_start_ms
        or compute_bucket_start_ms(
            actual_end_ms - 1,
            base_interval_ms,
            interval=config.base_interval,
        )
        != actual_end_ms - base_interval_ms
    ):
        raise _fail(
            "HISTORY_BOUNDARY_INVALID",
            "training display projection cursor is not base-interval aligned",
            status_code=503,
        )
    actual_start_ms = mapper.actual_anchor_ms
    if no_revealed_bars:
        bars: list[ReplayDisplayBar] = []
        has_more = False
    else:
        aggregate_start_ms = actual_start_ms
        aggregate_limit = limit
        aggregate_required = True
        if display_source_revision is not None:
            last_observed_open_ms = mapper.actual_containing_bucket_open(
                actual_end_ms - 1
            )
            if mapper.actual_bucket_end(last_observed_open_ms) <= actual_end_ms:
                # Every requested bucket is closed and therefore comes from
                # the pinned native series below; no base aggregation is needed.
                aggregate_required = False
            else:
                # Native candles are forbidden for the still-forming bucket.
                # Aggregate only that one bucket from the revealed base prefix.
                aggregate_start_ms = last_observed_open_ms
                aggregate_limit = 1
        if aggregate_required:
            try:
                aggregated = query_source_buckets(
                    snapshot.provenance.source_revision,
                    config.symbol,
                    config.base_interval,
                    display_interval,
                    actual_start_ms=aggregate_start_ms,
                    actual_end_ms=actual_end_ms,
                    actual_replay_start_ms=actual_replay_start_ms,
                    public_replay_start_ms=snapshot.replay_start_ms,
                    limit=aggregate_limit,
                    include_partial=True,
                    source_bucket_anchor_ms=display_source_bucket_anchor_ms,
                    exchange=config.exchange,
                    market_type=config.market_type,
                )
                raw_bars = aggregated["bars"]
                has_more = aggregated["has_more"]
                if not isinstance(raw_bars, list) or not isinstance(has_more, bool):
                    raise TypeError("source-aligned projection result is invalid")
                bars = [
                    ReplayDisplayBar.from_dict(raw)
                    for raw in raw_bars
                    if isinstance(raw, Mapping)
                ]
                if len(bars) != len(raw_bars):
                    raise TypeError("source-aligned projection bars are invalid")
            except Exception as exc:
                raise _fail(
                    "HISTORY_SOURCE_UNAVAILABLE",
                    "training display projection source could not be aggregated",
                    status_code=503,
                ) from exc
        else:
            bars = []
            has_more = False
        bars = _replace_closed_projection_buckets_from_native(
            repository=repository,
            snapshot=snapshot,
            config=projection_config,
            mapper=mapper,
            display_source_revision=display_source_revision,
            actual_end_ms=actual_end_ms,
            actual_replay_start_ms=actual_replay_start_ms,
            limit=limit,
            bars=bars,
            verified_halts=verified_halts,
        )
        if display_source_revision is not None and bars:
            has_more = (
                has_more or mapper.public_bucket_ordinal(bars[0].open_time_ms) > 0
            )
    for bar in bars:
        if (
            bar.open_time_ms > revealed_boundary_ms
            or bar.last_base_open_ms > revealed_boundary_ms
            or (bar.is_closed and bar.close_time_ms > revealed_boundary_ms)
        ):
            raise _fail(
                "HISTORY_SOURCE_INCOMPLETE",
                "training display projection crossed the public cursor",
                status_code=503,
            )
    projection_epoch = canonical_sha256(
        {
            "schema_version": "replay.display-projection-epoch.v4",
            "run_id": binding["run_id"],
            "session_id": binding["session_id"],
            "track_id": binding["track_id"],
            "identity": dict(identity),
            "data_epoch": data_epoch,
            "display_interval": projection_config.display_interval,
            "revealed_boundary_ms": revealed_boundary_ms,
            "source_revision": snapshot.provenance.source_revision,
            "display_source_revision": display_source_revision,
            "display_grid_commitment": display_grid_commitment,
            "closed_native_authority": "pinned-closed-only.v1",
            "verified_market_halts": [halt.to_dict() for halt in verified_halts],
        }
    )
    return {
        "protocol": "replay.v2",
        "schema_version": "replay.display-projection.v1",
        "run_id": str(binding["run_id"]),
        "session_id": str(binding["session_id"]),
        "track_id": str(binding["track_id"]),
        "identity": identity,
        "data_epoch": data_epoch,
        "projection_epoch": projection_epoch,
        "display_interval": projection_config.display_interval,
        "revealed_boundary_ms": revealed_boundary_ms,
        "bars": [bar.to_dict() for bar in bars[-limit:]],
        "has_more": has_more or len(bars) > limit,
    }


__all__ = [
    "HISTORY_SCHEMA_VERSION",
    "MAX_HISTORY_PAGE_BARS",
    "MAX_HISTORY_QUERY_BASE_ROWS",
    "build_display_projection",
    "build_history_page",
]
