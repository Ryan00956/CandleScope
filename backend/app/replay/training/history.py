"""Revealed-only history pages for the replay training workspace."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, replace

from app.data_engine.interval_policy import compute_bucket_start_ms, parse_interval_ms
from app.replay.bars.builder import ReplayBarBuilder, ReplayDisplayBar
from app.replay.canonical import canonical_sha256
from app.replay.catalog import KlinesReadRepository
from app.replay.dataset import (
    BarDatasetSnapshot,
    remap_bar_snapshot_time,
    validate_replay_repository_bar,
)
from app.replay.errors import ReplayDomainError
from app.replay.models import ReplaySessionConfig

from .errors import TrainingRunError


HISTORY_SCHEMA_VERSION = "replay.history.v2"
HISTORY_EPOCH_SCHEMA_VERSION = "replay.history-epoch.v2"
MAX_HISTORY_PAGE_BARS = 1_000
MAX_HISTORY_QUERY_BASE_ROWS = 100_000


@dataclass(frozen=True, slots=True)
class _NativeDisplayHistoryContext:
    interval_ms: int
    actual_anchor_ms: int
    public_anchor_ms: int
    timeline_offset_ms: int
    actual_boundary_ms: int
    public_boundary_ms: int


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
        snapshot = remap_bar_snapshot_time(
            snapshot,
            synthetic_replay_start_ms=synthetic_origin,
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
        or snapshot.provenance.source_revision is not None
    ):
        # An archive revision binds one exact base-interval catalog.  Building
        # display candles from that pinned base keeps ALL_AVAILABLE deterministic
        # even if a separately stored native display catalog is republished.
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
    last_complete_open_ms = actual_anchor_ms - display_interval_ms
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
) -> tuple[list[ReplayDisplayBar], int, bool]:
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
        return [], before_ms, False
    actual_end_ms = public_end_ms - context.timeline_offset_ms
    try:
        raw_rows = _query_bound_repository(
            repository,
            snapshot,
            config.symbol,
            config.display_interval,
            start_ms=context.actual_boundary_ms,
            end_ms=actual_end_ms - context.interval_ms,
            limit=limit + 1,
            order="DESC",
            exchange=config.exchange,
            market_type=config.market_type,
        )
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "replay display history source could not be read",
            status_code=503,
        ) from exc

    expected_open_ms = actual_end_ms - context.interval_ms
    contiguous_rows = []
    try:
        for raw in raw_rows:
            raw_open_ms = int(raw["open_time"])
            if raw_open_ms != expected_open_ms:
                # A native-series gap is the start of the currently usable
                # continuous context. Never jump across it or paint holes.
                break
            contiguous_rows.append(
                validate_replay_repository_bar(
                    raw,
                    identity=snapshot.identity,
                    interval=config.display_interval,
                    interval_ms=context.interval_ms,
                    expected_open_ms=expected_open_ms,
                    now_ms=actual_replay_start_ms,
                )
            )
            expected_open_ms -= context.interval_ms
    except (KeyError, TypeError, ValueError, ReplayDomainError) as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay display history changed inside the bound continuous range",
            status_code=503,
        ) from exc

    selected = contiguous_rows[:limit]
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
            last_base_open_ms=row.open_time_ms + context.timeline_offset_ms,
            component_count=1,
            expected_components=1,
            is_closed=True,
            synthetic=False,
        )
        for row in reversed(selected)
    ]
    has_more = len(contiguous_rows) > limit
    next_before_ms = page[0].open_time_ms if page else before_ms
    return page, next_before_ms, has_more


def _build_all_available_page(
    *,
    repository: KlinesReadRepository,
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
    before_ms: int,
    revealed_boundary_ms: int,
    limit: int,
    history_boundary_ms: int,
    actual_visible_history_start_ms: int,
    actual_replay_start_ms: int,
    interval_ms: int,
) -> tuple[list[ReplayDisplayBar], int, bool]:
    """Read one bounded chart page without expanding the execution snapshot."""

    timeline_delta_ms = snapshot.replay_start_ms - actual_replay_start_ms
    public_end_ms = min(before_ms, snapshot.replay_start_ms)
    actual_end_ms = public_end_ms - timeline_delta_ms
    actual_end_ms = compute_bucket_start_ms(
        actual_end_ms,
        interval_ms,
        interval=config.base_interval,
    )
    public_end_ms = actual_end_ms + timeline_delta_ms
    if actual_end_ms <= actual_visible_history_start_ms:
        return [], before_ms, False
    distance_ms = actual_end_ms - actual_visible_history_start_ms
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
    components_per_display = max(
        1,
        (display_interval_ms + interval_ms - 1) // interval_ms,
    )
    available_rows = distance_ms // interval_ms
    target_rows = max(
        components_per_display * 2,
        (limit + 1) * components_per_display,
    )
    query_rows = min(
        available_rows,
        MAX_HISTORY_QUERY_BASE_ROWS,
        target_rows,
    )
    query_start_ms = actual_end_ms - query_rows * interval_ms
    try:
        raw_rows = _query_bound_repository(
            repository,
            snapshot,
            config.symbol,
            config.base_interval,
            start_ms=query_start_ms,
            end_ms=actual_end_ms - interval_ms,
            limit=query_rows,
            order="ASC",
            exchange=config.exchange,
            market_type=config.market_type,
        )
    except Exception as exc:
        raise _fail(
            "HISTORY_SOURCE_UNAVAILABLE",
            "replay history source could not be read",
            status_code=503,
        ) from exc
    if len(raw_rows) != query_rows:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history source no longer covers the bound continuous range",
            status_code=503,
        )

    actual_rows = []
    try:
        for index, raw in enumerate(raw_rows):
            actual_rows.append(
                validate_replay_repository_bar(
                    raw,
                    identity=snapshot.identity,
                    interval=config.base_interval,
                    interval_ms=interval_ms,
                    expected_open_ms=query_start_ms + index * interval_ms,
                    # Every requested history row must already have been closed
                    # at the immutable replay start.
                    now_ms=actual_replay_start_ms,
                )
            )
    except ReplayDomainError as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history source changed inside the bound continuous range",
            status_code=503,
        ) from exc

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
    try:
        builder = ReplayBarBuilder(
            base_interval=config.base_interval,
            display_interval=config.display_interval,
            replay_start_ms=public_end_ms,
            warmup_bars=public_rows,
            max_closed_bars=max(1, limit + 1),
        )
    except ReplayDomainError as exc:
        raise _fail(
            "HISTORY_SOURCE_INCOMPLETE",
            "replay history source cannot reconstruct the display interval",
            status_code=503,
        ) from exc

    eligible = [
        bar
        for bar in builder.closed_bars
        if bar.open_time_ms >= history_boundary_ms
        and bar.open_time_ms < before_ms
        and bar.close_time_ms <= revealed_boundary_ms
        and bar.last_base_open_ms <= revealed_boundary_ms
    ]
    page = eligible[-limit:]
    has_more = (
        query_start_ms > actual_visible_history_start_ms
        or len(eligible) > len(page)
    )
    if not page and has_more:
        raise _fail(
            "HISTORY_PAGE_INTERVAL_TOO_LARGE",
            "display interval requires more base rows than one history page can validate",
            status_code=409,
        )
    next_before_ms = page[0].open_time_ms if page else before_ms
    return list(page), next_before_ms, has_more


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
    base_history_boundary_ms = (
        snapshot.replay_start_ms
        + actual_visible_history_start_ms
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
        }
    else:
        native_context = None
        history_boundary_ms = base_history_boundary_ms
        history_source = {
            "mode": "FROZEN_BASE_RECONSTRUCTION",
            "display_interval": requested_display_interval,
            "public_boundary_ms": history_boundary_ms,
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
            page, next_before_ms, has_more = _build_native_display_page(
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
            page, next_before_ms, has_more = _build_all_available_page(
                repository=repository,
                config=history_config,
                snapshot=snapshot,
                before_ms=before_ms,
                revealed_boundary_ms=revealed_boundary_ms,
                limit=limit,
                history_boundary_ms=history_boundary_ms,
                actual_visible_history_start_ms=actual_visible_history_start_ms,
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
        "bars": [bar.to_dict() for bar in page],
        "next_before_ms": next_before_ms,
        "has_more": has_more,
    }


__all__ = [
    "HISTORY_SCHEMA_VERSION",
    "MAX_HISTORY_PAGE_BARS",
    "MAX_HISTORY_QUERY_BASE_ROWS",
    "build_history_page",
]
