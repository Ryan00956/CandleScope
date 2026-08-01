"""Revealed-only history pages for the replay training workspace."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, replace

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
)
from app.replay.bars.builder import ReplayBarBuilder, ReplayDisplayBar
from app.replay.canonical import canonical_sha256
from app.replay.catalog import KlinesReadRepository
from app.replay.dataset import (
    BarDatasetSnapshot,
    ReplayBar,
    remap_bar_snapshot_time,
    validate_replay_repository_bar,
)
from app.replay.errors import ReplayDomainError
from app.replay.models import ReplaySessionConfig

from .errors import TrainingRunError


HISTORY_SCHEMA_VERSION = "replay.history.v3"
HISTORY_EPOCH_SCHEMA_VERSION = "replay.history-epoch.v3"
MAX_HISTORY_PAGE_BARS = 1_000
MAX_HISTORY_QUERY_BASE_ROWS = 100_000


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
    interval_ms: int
    actual_anchor_ms: int
    public_anchor_ms: int
    timeline_offset_ms: int
    actual_boundary_ms: int
    public_boundary_ms: int


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


def _fail(code: str, message: str, *, status_code: int = 409) -> TrainingRunError:
    return TrainingRunError(code, message, status_code=status_code)


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
    try:
        decoded = json.loads(bytes(blob).decode("utf-8"))
        if not isinstance(decoded, Mapping):
            raise TypeError("snapshot root must be an object")
        bar_payload = decoded.get("bar_dataset", decoded)
        if not isinstance(bar_payload, Mapping):
            raise TypeError("bar dataset must be an object")
        snapshot = BarDatasetSnapshot.from_dict(bar_payload)
    except (UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise _fail(
            "HISTORY_SNAPSHOT_INVALID",
            "training history snapshot is invalid",
            status_code=503,
        ) from exc

    if config.blind_mode:
        synthetic_origin = persisted.get("synthetic_origin_ms")
        if isinstance(synthetic_origin, bool) or not isinstance(synthetic_origin, int):
            raise _fail(
                "HISTORY_SNAPSHOT_INVALID",
                "blind training history snapshot is invalid",
                status_code=503,
            )
        repository_backend = snapshot.provenance.repository_backend
        snapshot = remap_bar_snapshot_time(
            snapshot,
            synthetic_replay_start_ms=synthetic_origin,
        )
        # Actor checkpoints intentionally use the redacted synthetic backend,
        # but server-side ALL_AVAILABLE reads still need the persisted source
        # identity to reject legacy Runs after a repository migration.
        snapshot = replace(
            snapshot,
            provenance=replace(
                snapshot.provenance,
                repository_backend=repository_backend,
            ),
        )
    return snapshot


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
    if (
        not isinstance(lookback, Mapping)
        or set(lookback) != {"mode", "duration_ms"}
    ):
        raise _fail(
            "HISTORY_POLICY_INVALID",
            "training history policy is invalid",
            status_code=503,
        )
    mode = lookback.get("mode")
    duration_ms = lookback.get("duration_ms")
    if (
        mode not in {"DURATION", "ALL_AVAILABLE"}
        or (mode == "DURATION" and (
            isinstance(duration_ms, bool)
            or not isinstance(duration_ms, int)
            or duration_ms < 1
        ))
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
) -> list[dict]:
    source_revision = snapshot.provenance.source_revision
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
                raise RuntimeError(
                    "bound replay-history revision has no bounds reader"
                )
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
        snapshot.replay_start_ms
        + source_start_ms
        - actual_replay_start_ms
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
) -> list[tuple[int, int, str]]:
    if start_ms > end_ms:
        return []
    source_revision = snapshot.provenance.source_revision
    try:
        if source_revision is not None:
            scan_gaps = getattr(repository, "scan_gaps_at_revision", None)
            if not callable(scan_gaps):
                raise RuntimeError(
                    "bound replay-history revision has no gap reader"
                )
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
    if any(
        current[0] <= previous[1]
        for previous, current in zip(gaps, gaps[1:])
    ):
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


def _resolve_native_display_context(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    actual_replay_start_ms: int,
) -> _NativeDisplayHistoryContext | None:
    """Bind chart-only context to the stored display series when it is longer.

    Blind replay shifts the base timeline by an arbitrary number of minutes.
    Native display candles therefore cannot preserve both their real exchange
    bucket and that shifted public bucket.  Context is mapped ordinally onto
    complete public display slots, and the one native bucket touching the
    replay seam remains excluded.  The replay-owned base prefix is authoritative
    at and after that seam.
    """

    if (
        config.display_interval == config.base_interval
        or is_monthly_interval(config.display_interval)
        or snapshot.provenance.source_revision is not None
    ):
        # An archive revision binds one exact base-interval catalog.  Building
        # display candles from that pinned base keeps ALL_AVAILABLE deterministic
        # even if a separately stored native display catalog is republished.
        # Calendar-month buckets cannot be shifted between real and blind
        # synthetic timelines with one millisecond offset; reconstructing them
        # from the bound base rows preserves public calendar boundaries.
        return None
    display_interval_ms = parse_interval_ms(config.display_interval)
    if display_interval_ms is None or display_interval_ms < 1:
        return None
    actual_anchor_ms = compute_bucket_start_ms(
        actual_replay_start_ms,
        display_interval_ms,
        interval=config.display_interval,
    )
    public_anchor_ms = compute_bucket_start_ms(
        snapshot.replay_start_ms,
        display_interval_ms,
        interval=config.display_interval,
    )
    last_complete_open_ms = _previous_bucket_start_ms(
        actual_anchor_ms,
        display_interval_ms,
        interval=config.display_interval,
    )
    if last_complete_open_ms < 0:
        return None
    try:
        bounds = repository.get_bounds(
            config.symbol,
            config.display_interval,
            exchange=config.exchange,
            market_type=config.market_type,
        )
    except Exception:
        # The immutable base snapshot remains a valid fallback when the local
        # display series is absent or its optional bounds lookup is unavailable.
        return None
    earliest_open_ms = _safe_bound(bounds.get("earliest_open_time"))
    latest_open_ms = _safe_bound(bounds.get("latest_open_time"))
    if (
        earliest_open_ms is None
        or latest_open_ms is None
        or earliest_open_ms > last_complete_open_ms
        or latest_open_ms < last_complete_open_ms
        or compute_bucket_start_ms(
            earliest_open_ms,
            display_interval_ms,
            interval=config.display_interval,
        ) != earliest_open_ms
    ):
        return None

    timeline_offset_ms = public_anchor_ms - actual_anchor_ms
    actual_boundary_ms = earliest_open_ms
    if actual_boundary_ms + timeline_offset_ms < 0:
        skipped = (
            -(actual_boundary_ms + timeline_offset_ms)
            + display_interval_ms
            - 1
        ) // display_interval_ms
        actual_boundary_ms += skipped * display_interval_ms
    if actual_boundary_ms > last_complete_open_ms:
        return None
    return _NativeDisplayHistoryContext(
        interval_ms=display_interval_ms,
        actual_anchor_ms=actual_anchor_ms,
        public_anchor_ms=public_anchor_ms,
        timeline_offset_ms=timeline_offset_ms,
        actual_boundary_ms=actual_boundary_ms,
        public_boundary_ms=actual_boundary_ms + timeline_offset_ms,
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

    revealed_end_ms = compute_bucket_start_ms(
        revealed_boundary_ms + 1,
        context.interval_ms,
        interval=config.display_interval,
    )
    public_end_ms = min(
        before_ms,
        context.public_anchor_ms,
        revealed_end_ms,
    )
    if compute_bucket_start_ms(
        public_end_ms,
        context.interval_ms,
        interval=config.display_interval,
    ) != public_end_ms:
        raise _fail(
            "HISTORY_CURSOR_INVALID",
            "training display history cursor is not interval aligned",
        )
    if public_end_ms <= context.public_boundary_ms:
        return _HistoryPageResult((), before_ms, False)
    actual_end_ms = public_end_ms - context.timeline_offset_ms
    last_requested_open_ms = _previous_bucket_start_ms(
        actual_end_ms,
        context.interval_ms,
        interval=config.display_interval,
    )
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
            if (
                raw_open_ms >= previous_open_ms
                or raw_open_ms < context.actual_boundary_ms
                or compute_bucket_start_ms(
                    raw_open_ms,
                    context.interval_ms,
                    interval=config.display_interval,
                )
                != raw_open_ms
            ):
                raise ValueError("native history ordering is invalid")
            validated_rows.append(
                validate_replay_repository_bar(
                    raw,
                    identity=snapshot.identity,
                    interval=config.display_interval,
                    interval_ms=context.interval_ms,
                    expected_open_ms=raw_open_ms,
                    now_ms=actual_replay_start_ms,
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
    page = [
        ReplayDisplayBar(
            open_time_ms=row.open_time_ms + context.timeline_offset_ms,
            close_time_ms=row.close_time_ms + context.timeline_offset_ms,
            open=row.open,
            high=row.high,
            low=row.low,
            close=row.close,
            volume=row.volume,
            quote_volume=row.quote_volume,
            trades=row.trades,
            taker_buy_base=row.taker_buy_base,
            taker_buy_quote=row.taker_buy_quote,
            first_base_open_ms=row.open_time_ms + context.timeline_offset_ms,
            last_base_open_ms=(
                row.close_time_ms
                + context.timeline_offset_ms
                - base_interval_ms
                + 1
            ),
            component_count=max(
                1,
                (row.close_time_ms - row.open_time_ms + 1) // base_interval_ms,
            ),
            expected_components=max(
                1,
                (row.close_time_ms - row.open_time_ms + 1) // base_interval_ms,
            ),
            is_closed=True,
            synthetic=False,
        )
        for row in reversed(selected)
    ]
    has_more = len(validated_rows) > limit
    next_before_ms = page[0].open_time_ms if page else before_ms
    excluded_ranges = _declared_page_exclusions(
        repository=repository,
        snapshot=snapshot,
        config=config,
        bars=page,
        connection_before_ms=public_end_ms,
        timeline_delta_ms=context.timeline_offset_ms,
        source_interval=config.display_interval,
        source_interval_ms=context.interval_ms,
    )
    return _HistoryPageResult(
        tuple(page),
        next_before_ms,
        has_more,
        excluded_ranges,
    )


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
            or row.open_time_ms
            != segments[-1][-1].open_time_ms + interval_ms
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
    source_has_more = bool(
        descending
        and descending[-1].open_time_ms > actual_start_ms
    )
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
    query_aggregated = getattr(
        repository,
        "query_aggregated_bars_at_revision",
        None,
    )
    can_use_archive_aggregate = (
        source_revision is not None
        and callable(query_aggregated)
        and display_interval_ms > interval_ms
        and display_interval_ms % interval_ms == 0
        and not is_monthly_interval(config.display_interval)
    )
    if can_use_archive_aggregate:
        revealed_end_ms = compute_bucket_start_ms(
            revealed_boundary_ms + 1,
            display_interval_ms,
            interval=config.display_interval,
        )
        aggregate_public_end_ms = min(public_end_ms, revealed_end_ms)
        aggregate_actual_end_ms = aggregate_public_end_ms - timeline_delta_ms
        if aggregate_actual_end_ms <= actual_history_start_ms:
            return _HistoryPageResult((), before_ms, False)
        try:
            aggregated = query_aggregated(
                source_revision,
                config.symbol,
                config.base_interval,
                config.display_interval,
                actual_start_ms=actual_history_start_ms,
                actual_end_ms=aggregate_actual_end_ms,
                timeline_delta_ms=timeline_delta_ms,
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
            # A maintenance gap can be wider than the archive aggregate cache's
            # bounded time probe. Fall back to a present-row query so the page
            # can jump to the previous declared source segment.
            return _build_gapped_aggregate_page(
                repository=repository,
                config=config,
                snapshot=snapshot,
                before_ms=before_ms,
                revealed_boundary_ms=revealed_boundary_ms,
                history_boundary_ms=history_boundary_ms,
                actual_start_ms=actual_history_start_ms,
                actual_end_ms=aggregate_actual_end_ms,
                interval_ms=interval_ms,
                timeline_delta_ms=timeline_delta_ms,
                limit=limit,
            )
        next_before_ms = page[0].open_time_ms if page else before_ms
        exclusions = _declared_page_exclusions(
            repository=repository,
            snapshot=snapshot,
            config=config,
            bars=page,
            connection_before_ms=aggregate_public_end_ms,
            timeline_delta_ms=timeline_delta_ms,
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
            raise _fail("TRAINING_RUN_INVALID", f"{field_name} must be an integer", status_code=422)
    if before_ms < 0 or revealed_boundary_ms < 0:
        raise _fail("TRAINING_RUN_INVALID", "history timestamps cannot be negative", status_code=422)
    if limit < 1 or limit > MAX_HISTORY_PAGE_BARS:
        raise _fail("TRAINING_RUN_INVALID", "history page limit is out of range", status_code=422)
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
        config.display_interval
        if display_interval is None
        else display_interval
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
        snapshot.replay_start_ms
        + actual_history_start_ms
        - actual_replay_start_ms
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
    native_context = (
        _resolve_native_display_context(
            repository=repository,
            config=history_config,
            snapshot=snapshot,
            actual_replay_start_ms=actual_replay_start_ms,
        )
        if history_mode == "ALL_AVAILABLE" and repository is not None
        else None
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
            if key not in {
                "actual_visible_history_start_ms",
                "actual_replay_start_ms",
            }
        },
        "revealed_boundary_ms": revealed_boundary_ms,
        "bars": [bar.to_dict() for bar in page_result.bars],
        "excluded_ranges": [
            item.to_dict() for item in page_result.excluded_ranges
        ],
        "next_before_ms": page_result.next_before_ms,
        "has_more": page_result.has_more,
    }


__all__ = [
    "HISTORY_SCHEMA_VERSION",
    "MAX_HISTORY_PAGE_BARS",
    "MAX_HISTORY_QUERY_BASE_ROWS",
    "build_history_page",
]
