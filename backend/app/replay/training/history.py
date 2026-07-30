"""Revealed-only history pages for the replay training workspace."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import replace

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
) -> dict[str, str]:
    return {
        "exchange": config.exchange,
        "market_type": config.market_type,
        "symbol": config.symbol,
        "source_kind": config.source_kind.value.upper(),
        "base_interval": config.base_interval,
        "display_interval": config.display_interval,
    }


def _assert_source_binding(
    binding: Mapping[str, object],
    config: ReplaySessionConfig,
    snapshot: BarDatasetSnapshot,
) -> dict[str, str]:
    identity = _identity(binding, config)
    expected = {
        "exchange": binding["exchange"],
        "market_type": binding["market_type"],
        "symbol": binding["symbol"],
        "source_kind": binding["source_kind"],
        "base_interval": binding["base_interval"],
        "display_interval": binding["display_interval"],
    }
    snapshot_identity = snapshot.identity.to_dict()
    if (
        identity != expected
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
        raw_rows = repository.query_bars(
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
    identity = _assert_source_binding(binding, config, snapshot)
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
    history_boundary_ms = (
        snapshot.replay_start_ms
        + actual_visible_history_start_ms
        - actual_replay_start_ms
    )
    if (
        history_boundary_ms < 0
        or history_boundary_ms > snapshot.replay_start_ms
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
    history_epoch = _history_epoch(
        binding=binding,
        identity=identity,
        snapshot=snapshot,
        data_epoch=data_epoch,
        history_boundary_ms=history_boundary_ms,
        policy_hash=policy_hash,
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
        page, next_before_ms, has_more = _build_all_available_page(
            repository=repository,
            config=config,
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
            base_interval=config.base_interval,
            display_interval=config.display_interval,
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
