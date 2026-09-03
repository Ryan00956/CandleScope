"""Bridge DataManager events into the IndicatorEngine."""
from __future__ import annotations

from .series_reference import identity_kwargs, meta_from_key, series_reference

import asyncio
import logging
from collections import OrderedDict
from typing import Any

from app.core.executors import run_storage
from app.data_engine.data_manager.models import DataEventType
from app.data_engine.interval_policy import (
    compute_bucket_start_ms,
    find_best_base_interval,
    intervals_equivalent,
    is_standard_interval,
    parse_custom_interval,
    parse_interval_ms,
    parse_monthly_count,
)
from app.data_engine.interval_resolution import IntervalPurpose, IntervalRouteKind
from app.indicator import create_engine

logger = logging.getLogger("candlescope.indicator.bridge")

_COMPLETED_BACKFILL_REQUEST_LIMIT = 512
_INDICATOR_REFRESH_TARGET_LIMIT = 5_000
_INDICATOR_REFRESH_SOURCE_BUDGET = 5_000
_CUSTOM_QUERY_GUARD_BUCKETS = 3
_CORRECTION_SNAPSHOT_ATTEMPTS = 2


def _revision_token(revision: dict[str, Any] | None) -> str:
    if not isinstance(revision, dict):
        return ""
    explicit = str(revision.get("revisionToken") or "").strip()
    if explicit:
        return explicit
    return (
        f"{revision.get('serverEpoch', '')}:"
        f"{revision.get('correctionRevision', 0)}"
    )


def _indicator_refresh_limit(
    data_manager: Any,
    interval: str,
    *,
    exchange: str,
    market_type: str,
    required_target_bars: int | None = None,
) -> int:
    """Bound a derived refresh by source rows, not only target rows.

    ``query_latest`` expands a custom target into ``(limit + 3) * factor``
    base rows.  A fixed 5,000-target refresh for 91m therefore asks for more
    than 455,000 1m rows.  Keep the existing target limit for native series,
    but cap derived work to one ordinary source-history page.
    """
    required = (
        min(_INDICATOR_REFRESH_TARGET_LIMIT, max(1, int(required_target_bars)))
        if required_target_bars is not None
        else None
    )
    if is_standard_interval(interval):
        return required or _INDICATOR_REFRESH_TARGET_LIMIT

    custom_seconds = parse_custom_interval(interval)
    target_ms = parse_interval_ms(interval)
    if custom_seconds is None or target_ms is None or target_ms <= 0:
        return 0

    base_interval: str | None = None
    resolver = getattr(data_manager, "interval_resolver", None)
    if resolver is not None:
        try:
            route = resolver.resolve(
                exchange=exchange,
                market_type=market_type,
                interval=interval,
                purpose=IntervalPurpose.HISTORY,
            )
            if route.kind is IntervalRouteKind.NATIVE:
                return _INDICATOR_REFRESH_TARGET_LIMIT
            base_interval = route.base_interval
        except Exception:
            # The query call remains the authority for routing/errors.  This
            # helper only needs a conservative fallback for its work budget.
            base_interval = None

    nominal_factor = 1
    if base_interval is None:
        base_interval, nominal_factor = find_best_base_interval(
            custom_seconds,
            interval=interval,
        )
    base_ms = parse_interval_ms(base_interval)
    if base_ms is None or base_ms <= 0:
        return 0
    nominal_factor = max(nominal_factor, (target_ms + base_ms - 1) // base_ms)
    month_count = parse_monthly_count(interval)
    capacity_factor = (
        max(
            nominal_factor,
            (month_count * 31 * 86_400_000 + base_ms - 1) // base_ms,
        )
        if month_count is not None
        else nominal_factor
    )
    target_limit = (
        _INDICATOR_REFRESH_SOURCE_BUDGET // capacity_factor
        - _CUSTOM_QUERY_GUARD_BUCKETS
    )
    budget_limit = max(
        0,
        min(_INDICATOR_REFRESH_TARGET_LIMIT, target_limit),
    )
    # The source-row budget is an idle/default optimization, not permission to
    # truncate an active recursive/windowed instance.  Active work keeps its
    # existing target-bar span, capped by the same 5k target safety ceiling.
    return max(budget_limit, required or 0)


def _engine_correction_plan(
    indicator_engine: Any,
    event: Any,
    *,
    interval: str,
    dirty_range: dict[str, int],
) -> dict[str, Any]:
    planner = getattr(indicator_engine, "plan_series_correction", None)
    if not callable(planner):
        return {
            "hasActive": True,
            "requiresRecompute": True,
            "requiredTargetBars": None,
        }
    return planner(
        event.key.symbol,
        interval,
        market_type=event.key.market_type,
        exchange=event.key.exchange,
        dirty_range=dirty_range,
        **identity_kwargs(meta_from_key(event.key)),
    )


def bridge_indicator_engine(
    data_manager: Any,
    *,
    backfill_coordinator: Any | None = None,
    result_service: Any | None = None,
) -> Any:
    """Create an IndicatorEngine and subscribe it to DataManager events."""
    indicator_engine = create_engine()
    # The WebSocket Pyne path observes the same completion events as this
    # bridge.  Expose the authoritative parent-request future so it can wait
    # for every written range before rebuilding an incremental snapshot.
    indicator_engine.backfill_coordinator = backfill_coordinator
    if result_service is not None:
        result_service.bind_engine(indicator_engine)
    pending_backfills: dict[str, asyncio.Task[None]] = {}
    pending_series_refreshes: dict[str, dict[str, Any]] = {}
    completed_backfills: OrderedDict[str, None] = OrderedDict()

    def _remember_completed(request_id: str) -> None:
        completed_backfills.pop(request_id, None)
        completed_backfills[request_id] = None
        while len(completed_backfills) > _COMPLETED_BACKFILL_REQUEST_LIMIT:
            completed_backfills.popitem(last=False)

    async def _on_bar_event(event: Any) -> None:
        bar = event.bar
        if bar is None:
            return
        symbol = event.key.symbol
        interval = event.key.interval
        market_type = event.key.market_type
        exchange = event.key.exchange

        if event.event_type == DataEventType.BAR_CLOSED:
            if result_service is not None:
                result_service.note_closed(
                    series_key=series_reference(meta_from_key(event.key)),
                    closed_through=int(bar.time),
                )
            indicator_engine.on_bar_closed(
                symbol,
                interval,
                bar,
                market_type=market_type,
                exchange=exchange,
                **identity_kwargs(meta_from_key(event.key)),
            )
        elif event.event_type == DataEventType.BAR_UPDATED:
            indicator_engine.on_bar_updated(
                symbol,
                interval,
                bar,
                market_type=market_type,
                exchange=exchange,
                **identity_kwargs(meta_from_key(event.key)),
            )

    async def _recompute_after_backfill(
        event: Any,
        request_id: str | None,
        data_revision: dict[str, Any] | None,
        *,
        interval: str,
        dirty_range: dict[str, int],
    ) -> bool:
        symbol = event.key.symbol
        market_type = event.key.market_type
        exchange = event.key.exchange
        try:
            if backfill_coordinator is not None and request_id:
                outcome = await backfill_coordinator.wait_for_request(request_id)
                if outcome is None:
                    return False
                if (
                    getattr(outcome, "verified_contiguous", None) is not True
                    or bool(getattr(outcome, "retryable", False))
                ):
                    return False
                if int(getattr(outcome, "bars_loaded", 0) or 0) <= 0:
                    return True

            series_meta = meta_from_key(event.key, interval)
            revision_reader = getattr(
                result_service,
                "data_revision_for_meta",
                None,
            )
            snapshot_attempts = (
                _CORRECTION_SNAPSHOT_ATTEMPTS
                if callable(revision_reader)
                else 1
            )
            for snapshot_attempt in range(snapshot_attempts):
                correction_plan = _engine_correction_plan(
                    indicator_engine,
                    event,
                    interval=interval,
                    dirty_range=dirty_range,
                )
                if not bool(correction_plan.get("hasActive")):
                    return True
                if not bool(correction_plan.get("requiresRecompute")):
                    notify_invalidated = getattr(
                        indicator_engine,
                        "on_series_correction_invalidated",
                        None,
                    )
                    if callable(notify_invalidated):
                        notify_invalidated(
                            symbol,
                            interval,
                            market_type=market_type,
                            exchange=exchange,
                            dirty_range=dirty_range,
                            data_revision=data_revision,
                            **identity_kwargs(meta_from_key(event.key)),
                        )
                    return True

                snapshot_revision = (
                    revision_reader(series_meta)
                    if callable(revision_reader)
                    else data_revision
                )
                required_target_bars = correction_plan.get(
                    "requiredTargetBars"
                )
                refresh_limit = _indicator_refresh_limit(
                    data_manager,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    required_target_bars=required_target_bars,
                )
                if refresh_limit <= 0:
                    return False
                query_limit = refresh_limit
                if required_target_bars is not None:
                    # ``query_latest`` may include one forming tail.  Fetch
                    # one guard row, then keep exactly the requested number of
                    # closed bars so rebuilds neither shrink nor grow.
                    query_limit = min(
                        _INDICATOR_REFRESH_TARGET_LIMIT + 1,
                        refresh_limit + 1,
                    )
                result = await run_storage(
                    data_manager.query_latest,
                    symbol,
                    interval,
                    limit=query_limit,
                    exchange=exchange,
                    market_type=market_type,
                    auto_backfill=False,
                    **identity_kwargs(meta_from_key(event.key)),
                )
                if (
                    bool(getattr(result, "missing_ranges", None))
                    or bool(getattr(result, "retryable", False))
                    or getattr(result, "complete", True) is False
                ):
                    return False
                confirmed_bars = sorted(
                    (
                        bar
                        for bar in (result.bars or [])
                        if getattr(bar, "is_closed", True)
                    ),
                    key=lambda bar: int(bar.time),
                )
                if required_target_bars is not None:
                    target_count = max(1, int(required_target_bars))
                    if len(confirmed_bars) > target_count:
                        confirmed_bars = confirmed_bars[-target_count:]

                observed_revision = (
                    revision_reader(series_meta)
                    if callable(revision_reader)
                    else snapshot_revision
                )
                confirmed_end = max(
                    (int(bar.time) for bar in confirmed_bars),
                    default=0,
                )
                observed_closed = int(
                    (observed_revision or {}).get("closedThrough") or 0
                )
                replanned = _engine_correction_plan(
                    indicator_engine,
                    event,
                    interval=interval,
                    dirty_range=dirty_range,
                )
                required_after_query = int(
                    replanned.get("requiredTargetBars") or 0
                )
                snapshot_unstable = (
                    _revision_token(observed_revision)
                    != _revision_token(snapshot_revision)
                    or observed_closed > confirmed_end
                    or (
                        required_target_bars is not None
                        and required_after_query > int(required_target_bars)
                    )
                )
                if snapshot_unstable:
                    if snapshot_attempt + 1 >= snapshot_attempts:
                        return False
                    continue
                if not confirmed_bars:
                    return False

                emitted_revision = (
                    dict(observed_revision)
                    if isinstance(observed_revision, dict)
                    else data_revision
                )
                if (
                    isinstance(emitted_revision, dict)
                    and isinstance(data_revision, dict)
                ):
                    for field in ("dirtyRange", "historyInvalid"):
                        if field in data_revision:
                            emitted_revision[field] = data_revision[field]
                indicator_engine.on_bars_backfilled(
                    symbol,
                    interval,
                    confirmed_bars,
                    market_type=market_type,
                    exchange=exchange,
                    dirty_range=dirty_range,
                    data_revision=emitted_revision,
                    **identity_kwargs(meta_from_key(event.key)),
                )
                return True
            return False
        except Exception as exc:
            logger.warning("Indicator recompute after backfill failed: %s", exc)
            return False

    async def _run_backfill_refresh(
        task_key: str,
        event: Any,
        request_id: str | None,
        data_revision: dict[str, Any] | None,
        completion_key: str | None,
        interval: str,
        dirty_range: dict[str, int],
    ) -> None:
        current_event = event
        current_request_id = request_id
        current_data_revision = data_revision
        current_completion_key = completion_key
        current_interval = interval
        current_dirty_range = dirty_range
        try:
            while True:
                completed = await _recompute_after_backfill(
                    current_event,
                    current_request_id,
                    current_data_revision,
                    interval=current_interval,
                    dirty_range=current_dirty_range,
                )
                if completed and current_completion_key:
                    _remember_completed(current_completion_key)
                if current_completion_key:
                    break

                pending = pending_series_refreshes.pop(task_key, None)
                if pending is None:
                    break
                current_event = pending["event"]
                current_request_id = pending["request_id"]
                current_data_revision = pending["data_revision"]
                current_completion_key = pending["completion_key"]
                current_interval = pending["interval"]
                current_dirty_range = pending["dirty_range"]
        finally:
            pending_series_refreshes.pop(task_key, None)
            current_task = asyncio.current_task()
            if pending_backfills.get(task_key) is current_task:
                pending_backfills.pop(task_key, None)

    async def _on_backfill(event: Any) -> None:
        detail = event.detail if isinstance(event.detail, dict) else {}
        if is_zero_bar_backfill_completion(event):
            return
        raw_request_id = detail.get("request_id")
        request_id = str(raw_request_id).strip() if raw_request_id else None
        for interval, dirty_range in _backfill_refresh_targets(
            event,
            indicator_engine=indicator_engine,
            data_manager=data_manager,
            result_service=result_service,
        ):
            series_key = series_reference(meta_from_key(event.key, interval))
            completion_key = (
                f"{request_id}:{series_key}" if request_id else None
            )
            if completion_key and completion_key in completed_backfills:
                continue

            task_key = (
                f"request:{completion_key}"
                if completion_key
                else f"series:{series_key}"
            )
            existing = pending_backfills.get(task_key)
            if (
                completion_key
                and existing is not None
                and not existing.done()
            ):
                continue

            correction_plan = _engine_correction_plan(
                indicator_engine,
                event,
                interval=interval,
                dirty_range=dirty_range,
            )

            data_revision = None
            if result_service is not None:
                data_revision = result_service.note_correction(
                    series_key=series_key,
                    start=dirty_range["start"],
                    end=dirty_range["end"],
                    event_id=indicator_correction_event_id(
                        event,
                        interval=interval,
                        dirty_range=dirty_range,
                    ),
                )

            if not bool(correction_plan.get("hasActive")):
                if completion_key:
                    _remember_completed(completion_key)
                continue
            if not bool(correction_plan.get("requiresRecompute")):
                notify_invalidated = getattr(
                    indicator_engine,
                    "on_series_correction_invalidated",
                    None,
                )
                if callable(notify_invalidated):
                    notify_invalidated(
                        event.key.symbol,
                        interval,
                        market_type=event.key.market_type,
                        exchange=event.key.exchange,
                        dirty_range=dirty_range,
                        data_revision=data_revision,
                        **identity_kwargs(meta_from_key(event.key)),
                    )
                if completion_key:
                    _remember_completed(completion_key)
                continue

            if (
                completion_key is None
                and existing is not None
                and not existing.done()
            ):
                pending = pending_series_refreshes.get(task_key)
                if pending is not None:
                    dirty_range = {
                        "start": min(
                            int(pending["dirty_range"]["start"]),
                            int(dirty_range["start"]),
                        ),
                        "end": max(
                            int(pending["dirty_range"]["end"]),
                            int(dirty_range["end"]),
                        ),
                    }
                pending_series_refreshes[task_key] = {
                    "event": event,
                    "request_id": request_id,
                    "data_revision": data_revision,
                    "completion_key": completion_key,
                    "interval": interval,
                    "dirty_range": dirty_range,
                }
                continue

            pending_series_refreshes.pop(task_key, None)
            pending_backfills[task_key] = asyncio.create_task(
                _run_backfill_refresh(
                    task_key,
                    event,
                    request_id,
                    data_revision,
                    completion_key,
                    interval,
                    dirty_range,
                ),
                name=f"indicator-backfill-refresh:{task_key}",
            )

    data_manager.subscribe(
        callback=_on_bar_event,
        event_types={DataEventType.BAR_CLOSED, DataEventType.BAR_UPDATED},
    )
    data_manager.subscribe(
        callback=_on_backfill,
        event_types={DataEventType.BACKFILL_COMPLETED},
    )
    data_manager.subscribe(
        callback=_on_backfill,
        event_types={DataEventType.BAR_AMENDED},
    )

    return indicator_engine


def indicator_dirty_range_from_event(event: Any) -> dict[str, int]:
    """Return the actual amended/backfilled range in unix seconds."""
    if event.event_type == DataEventType.BAR_AMENDED and event.bar is not None:
        bar_time = int(event.bar.time)
        return {"start": bar_time, "end": bar_time}
    detail = event.detail if isinstance(event.detail, dict) else {}

    # A repair request may publish one BACKFILL_COMPLETED event per written
    # range.  Consumers rebuild once after the parent future settles, so the
    # invalidation must cover the complete parent request rather than whichever
    # chunk happened to publish first.
    request_id = str(detail.get("request_id") or "").strip()
    request_start_ms = detail.get("request_start_ms")
    request_end_ms = detail.get("request_end_ms")
    if (
        event.event_type == DataEventType.BACKFILL_COMPLETED
        and request_id
        and request_start_ms is not None
        and request_end_ms is not None
    ):
        start_s = int(request_start_ms) // 1000
        end_s = int(request_end_ms) // 1000
        return {"start": start_s, "end": max(start_s, end_s)}

    start = detail.get("earliest")
    end = detail.get("latest")
    if start is None:
        start_ms = detail.get("request_start_ms")
        if start_ms is None:
            start_ms = detail.get("range_start_ms")
        start = int(start_ms) // 1000 if start_ms is not None else 0
    if end is None:
        end_ms = detail.get("request_end_ms")
        if end_ms is None:
            end_ms = detail.get("range_end_ms")
        end = int(end_ms) // 1000 if end_ms is not None else start
    start_s = int(start or 0)
    return {"start": start_s, "end": max(start_s, int(end or start_s))}


def indicator_dirty_range_for_interval(
    event: Any,
    target_interval: str,
    *,
    data_manager: Any | None = None,
) -> dict[str, int] | None:
    """Map one storage correction onto a subscribed indicator interval.

    Backfill completions normally publish explicit derived repair targets.  A
    single historical ``BAR_AMENDED`` can arrive without that metadata (for
    example when no custom aggregator is resident), so infer the route from
    the DataManager's history resolver and project the source bar into the
    subscribed custom bucket.
    """
    source_interval = str(event.key.interval).strip()
    target_interval = str(target_interval).strip()
    if not target_interval:
        return None
    if intervals_equivalent(source_interval, target_interval):
        return indicator_dirty_range_from_event(event)

    detail = event.detail if isinstance(event.detail, dict) else {}
    raw_targets = detail.get("derived_repair_targets")
    derived_range: dict[str, int] | None = None
    if isinstance(raw_targets, (list, tuple)):
        for raw_target in raw_targets:
            if not isinstance(raw_target, dict):
                continue
            raw_interval = str(raw_target.get("interval") or "").strip()
            if not intervals_equivalent(raw_interval, target_interval):
                continue
            try:
                start_ms = int(raw_target["start_ms"])
                end_ms = int(raw_target["end_ms"])
            except (KeyError, TypeError, ValueError):
                continue
            if start_ms > end_ms:
                continue
            candidate = {
                "start": start_ms // 1000,
                "end": end_ms // 1000,
            }
            if derived_range is None:
                derived_range = candidate
            else:
                derived_range["start"] = min(
                    derived_range["start"],
                    candidate["start"],
                )
                derived_range["end"] = max(
                    derived_range["end"],
                    candidate["end"],
                )
    if derived_range is not None:
        return derived_range

    if event.event_type != DataEventType.BAR_AMENDED or event.bar is None:
        return None

    base_interval: str | None = None
    resolver = getattr(data_manager, "interval_resolver", None)
    if resolver is not None:
        try:
            route = resolver.resolve(
                exchange=event.key.exchange,
                market_type=event.key.market_type,
                interval=target_interval,
                purpose=IntervalPurpose.HISTORY,
            )
            if route.kind is IntervalRouteKind.DERIVED:
                base_interval = route.base_interval
        except Exception:
            base_interval = None

    # Test doubles and older DataManagers may not expose a resolver.  Only
    # infer non-standard intervals in that case so a native 5m subscription is
    # never spuriously rebuilt from an unrelated 1m amendment.
    if base_interval is None and not is_standard_interval(target_interval):
        custom_seconds = parse_custom_interval(target_interval)
        if custom_seconds is not None:
            base_interval, _ = find_best_base_interval(
                custom_seconds,
                interval=target_interval,
            )
    if (
        base_interval is None
        or not intervals_equivalent(base_interval, source_interval)
    ):
        return None

    target_ms = parse_interval_ms(target_interval)
    if target_ms is None or target_ms <= 0:
        return None
    bucket_start_ms = compute_bucket_start_ms(
        int(event.bar.time) * 1000,
        target_ms,
        interval=target_interval,
    )
    bucket_start_s = bucket_start_ms // 1000
    return {"start": bucket_start_s, "end": bucket_start_s}


def indicator_correction_event_id(
    event: Any,
    *,
    interval: str,
    dirty_range: dict[str, int],
) -> str:
    """Return the one deduplication id shared by all indicator consumers."""
    detail = event.detail if isinstance(event.detail, dict) else {}
    request_id = str(detail.get("request_id") or "").strip()
    if request_id:
        return f"backfill:{request_id}:{interval}"
    return (
        f"{event.event_type.value}:{event.key.exchange}:"
        f"{event.key.market_type}:{event.key.symbol}:{interval}:"
        f"{dirty_range['start']}:{dirty_range['end']}:"
        f"{getattr(event, 'timestamp_ms', 0)}"
    )


def is_zero_bar_backfill_completion(event: Any) -> bool:
    """Return true only for an explicit completion that wrote no K-lines."""
    if event.event_type != DataEventType.BACKFILL_COMPLETED:
        return False
    detail = event.detail if isinstance(event.detail, dict) else {}
    raw_bars_count = detail.get("bars_count")
    if raw_bars_count is None:
        return False
    try:
        return int(raw_bars_count) <= 0
    except (TypeError, ValueError):
        return False


def _backfill_refresh_targets(
    event: Any,
    *,
    indicator_engine: Any | None = None,
    data_manager: Any | None = None,
    result_service: Any | None = None,
) -> list[tuple[str, dict[str, int]]]:
    """Expand a base completion into every affected derived indicator series."""
    targets: list[tuple[str, dict[str, int]]] = [
        (str(event.key.interval), indicator_dirty_range_from_event(event))
    ]
    detail = event.detail if isinstance(event.detail, dict) else {}
    raw_targets = detail.get("derived_repair_targets")
    if not isinstance(raw_targets, (list, tuple)):
        raw_targets = ()
    base_interval = str(event.key.interval)
    derived_ranges: OrderedDict[str, dict[str, int]] = OrderedDict()
    for raw in raw_targets:
        if not isinstance(raw, dict):
            continue
        interval = str(raw.get("interval") or "").strip()
        try:
            start_ms = int(raw["start_ms"])
            end_ms = int(raw["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if (
            not interval
            or intervals_equivalent(interval, base_interval)
            or start_ms > end_ms
        ):
            continue
        dirty_range = {
            "start": start_ms // 1000,
            "end": end_ms // 1000,
        }
        existing = derived_ranges.get(interval)
        if existing is None:
            derived_ranges[interval] = dirty_range
        else:
            existing["start"] = min(existing["start"], dirty_range["start"])
            existing["end"] = max(existing["end"], dirty_range["end"])
    targets.extend(derived_ranges.items())

    if event.event_type == DataEventType.BAR_AMENDED:
        resident_intervals = getattr(
            indicator_engine,
            "resident_series_intervals",
            None,
        )
        if not callable(resident_intervals):
            resident_intervals = getattr(
                indicator_engine,
                "active_series_intervals",
                None,
            )
        candidate_intervals: set[str] = set()
        if callable(resident_intervals):
            candidate_intervals.update(
                resident_intervals(
                    event.key.symbol,
                    market_type=event.key.market_type,
                    exchange=event.key.exchange,
                    **identity_kwargs(meta_from_key(event.key)),
                )
            )
        cached_intervals = getattr(
            result_service,
            "resident_series_intervals",
            None,
        )
        if callable(cached_intervals):
            candidate_intervals.update(
                cached_intervals(
                    event.key.symbol,
                    market_type=event.key.market_type,
                    exchange=event.key.exchange,
                    **identity_kwargs(meta_from_key(event.key)),
                )
            )
        for interval in sorted(candidate_intervals):
            if intervals_equivalent(interval, base_interval):
                continue
            inferred = indicator_dirty_range_for_interval(
                    event,
                    interval,
                    data_manager=data_manager,
                )
            if inferred is None:
                continue
            existing = derived_ranges.get(interval)
            if existing is None:
                derived_ranges[interval] = inferred
                targets.append((interval, inferred))
            else:
                existing["start"] = min(existing["start"], inferred["start"])
                existing["end"] = max(existing["end"], inferred["end"])
    return targets


__all__ = [
    "bridge_indicator_engine",
    "indicator_correction_event_id",
    "indicator_dirty_range_for_interval",
    "indicator_dirty_range_from_event",
    "is_zero_bar_backfill_completion",
]
