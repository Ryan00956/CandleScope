"""
Kline API routes — powered by DataManager facade.

All endpoints delegate to the unified ``DataManager`` for data retrieval,
which provides:
  * Three-level query resolution: Cache → Storage → Backfill
  * Automatic stream management (auto-start ingestion on demand)
  * Consistent BarAggregator-based custom interval handling
  * Event-driven cache warming

The DataManager instance is stored on ``app.state.data_manager`` and
initialized during application startup (see ``app/main.py``).
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal

import orjson
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.core.executors import run_storage
from app.exchanges import (
    bootstrap_default_adapters,
    get_exchange_registry,
    supports_history_identity,
)
from app.exchanges.symbols import normalize_symbol
from app.core.market import (
    VALID_INTERVALS,
    parse_custom_interval,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolver,
    IntervalRouteKind,
)
from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    last_closed_bar_open_ms,
    parse_interval_ms,
)
from app.api.v1.related_warmup import (
    RelatedIntervalWarmupScheduler,
    RelatedWarmupSubmission,
)
from app.data_engine.history import (
    TradingCalendar,
    containing_expected_open_ms,
    expected_bucket_end_ms,
    latest_closed_expected_open_ms,
)
from app.data_engine.public_market_projection import public_bar_rows
from app.data_engine.storage import DEFAULT_EXCHANGE, DEFAULT_MARKET_TYPE
from app.data_engine.series_identity import (
    DEFAULT_ASSET_CLASS,
    DEFAULT_PRICE_ADJUSTMENT,
    DEFAULT_SERIES_VARIANT,
    DEFAULT_SESSION_VARIANT,
    DEFAULT_VOLUME_SEMANTICS,
    KlineSeriesIdentity,
)

router = APIRouter(prefix="/klines", tags=["klines"])
logger = logging.getLogger("api.klines")

RELATED_WARMUP_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")
MAX_RANGE_RESPONSE_BARS = 5_000
RELATED_WARMUP_MAX_INTERVALS = 1
RELATED_WARMUP_MAX_TARGET_BARS = 256
RELATED_WARMUP_TTL_SECONDS = 5 * 60.0
RELATED_WARMUP_DWELL_SECONDS = 1.0
RELATED_WARMUP_BUSY_RECHECK_SECONDS = 0.25
RELATED_WARMUP_REGISTRY_LIMIT = 512
BACKFILL_REQUERY_MAX_SECONDS = 1.0
BACKFILL_FINAL_REQUERY_GRACE_SECONDS = 0.5
BACKFILL_CLEANUP_GRACE_SECONDS = 0.25
HISTORY_BATCH_MAX_REQUESTS = 16
# Match the bounded storage executor: four reads let a 16-series first paint
# overlap SQLite I/O without opening the unbounded burst that previously
# starved the event loop. The release harness gates the exact 10 ms event-loop
# window at P99 <= 50 ms.
HISTORY_BATCH_MAX_CONCURRENCY = 4


class KlineHistoryBatchItem(BaseModel):
    """One independently validated history read in a bounded browser burst."""

    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=64)
    symbol: str = Field(default="BTCUSDT", min_length=1, max_length=64)
    interval: str = Field(default="1h", min_length=1, max_length=16)
    days: float = Field(default=7, ge=0.001)
    count_back: int | None = Field(default=None, ge=1, le=MAX_RANGE_RESPONSE_BARS)
    exchange: str = Field(default=DEFAULT_EXCHANGE, min_length=1, max_length=32)
    market_type: str = Field(default=DEFAULT_MARKET_TYPE, min_length=1, max_length=32)
    provider_id: str | None = Field(default=None, max_length=64)
    venue: str | None = Field(default=None, max_length=64)
    asset_class: str = Field(default=DEFAULT_ASSET_CLASS, min_length=1, max_length=64)
    series_variant: str = Field(default=DEFAULT_SERIES_VARIANT, min_length=1, max_length=64)
    price_adjustment: str = Field(default=DEFAULT_PRICE_ADJUSTMENT, min_length=1, max_length=64)
    session_variant: str = Field(default=DEFAULT_SESSION_VARIANT, min_length=1, max_length=64)
    volume_semantics: str = Field(default=DEFAULT_VOLUME_SEMANTICS, min_length=1, max_length=64)
    intent: Literal["viewport", "active_hydration"] = "viewport"
    request_scope: str | None = Field(default=None, max_length=128)
    request_generation: int | None = Field(default=None, ge=0)
    max_wait_ms: int = Field(default=3500, ge=0, le=8000)


class KlineHistoryBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requests: list[KlineHistoryBatchItem] = Field(
        min_length=1,
        max_length=HISTORY_BATCH_MAX_REQUESTS,
    )


class KlineSeriesIdentityQuery:
    """Additive query parameters for a semantically exact bar series."""

    def __init__(
        self,
        provider_id: str | None = Query(None, max_length=64),
        venue: str | None = Query(None, max_length=64),
        asset_class: str = Query(DEFAULT_ASSET_CLASS, min_length=1, max_length=64),
        series_variant: str = Query(DEFAULT_SERIES_VARIANT, min_length=1, max_length=64),
        price_adjustment: str = Query(DEFAULT_PRICE_ADJUSTMENT, min_length=1, max_length=64),
        session_variant: str = Query(DEFAULT_SESSION_VARIANT, min_length=1, max_length=64),
        volume_semantics: str = Query(DEFAULT_VOLUME_SEMANTICS, min_length=1, max_length=64),
    ) -> None:
        self.provider_id = provider_id
        self.venue = venue
        self.asset_class = asset_class
        self.series_variant = series_variant
        self.price_adjustment = price_adjustment
        self.session_variant = session_variant
        self.volume_semantics = volume_semantics

    def resolve(self, exchange: str) -> KlineSeriesIdentity:
        return KlineSeriesIdentity.for_exchange(
            exchange,
            provider_id=self.provider_id,
            venue=self.venue,
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )


def _resolve_series_identity_query(
    exchange: str,
    value: object,
) -> KlineSeriesIdentity:
    if isinstance(value, KlineSeriesIdentityQuery):
        return value.resolve(exchange)
    return KlineSeriesIdentity.for_exchange(exchange)


def _nonlegacy_identity_kwargs(
    exchange: str,
    identity: KlineSeriesIdentity,
) -> dict[str, KlineSeriesIdentity]:
    if identity.is_legacy_default_for(exchange):
        return {}
    return {"series_identity": identity}


def _series_history_supported(
    *,
    exchange: str,
    market_type: str,
    interval: str,
    identity: KlineSeriesIdentity,
) -> bool:
    """Whether the selected plugin owns this exact durable history series."""
    return supports_history_identity(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        identity=identity,
    )


# ═══════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════


def _get_data_manager(request: Request) -> Any:
    """Retrieve the DataManager from app state."""
    return getattr(request.app.state, "data_manager", None)


def _get_data_engine_runtime(request: Request) -> Any:
    return getattr(request.app.state, "data_engine_runtime", None)


def _get_backfill_coordinator(request: Request) -> Any:
    runtime = _get_data_engine_runtime(request)
    if runtime is not None:
        get_coordinator = getattr(runtime, "get_backfill_coordinator", None)
        if callable(get_coordinator):
            return get_coordinator()
    return getattr(request.app.state, "backfill_coordinator", None)


def _require_data_manager(request: Request) -> Any:
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    return dm


def _validate_interval(interval: str) -> None:
    """Accept both native exchange intervals and valid custom intervals."""
    if interval in VALID_INTERVALS:
        return
    parsed = parse_custom_interval(interval)
    if parsed is None or parsed <= 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported interval: {interval}. "
                f"Supported native: {VALID_INTERVALS}. "
                f"Custom format: <number><s|m|h|d|w|M>, e.g. 7m, 45m, 3h"
            ),
        )


def _validate_market_type(market_type: str) -> str:
    return (market_type or DEFAULT_MARKET_TYPE).strip().lower()


def _validate_exchange(exchange: str) -> str:
    normalized = (exchange or DEFAULT_EXCHANGE).strip().lower()
    bootstrap_default_adapters()
    if not get_exchange_registry().has(normalized):
        raise HTTPException(status_code=400, detail=f"Unsupported exchange: {exchange}")
    return normalized


def _resolve_interval(
    interval: str,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    purpose: IntervalPurpose = IntervalPurpose.HISTORY,
) -> dict:
    """Return exchange-aware resolution info for the requested interval."""
    route = IntervalResolver().resolve(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        purpose=purpose,
    )
    base_interval = (
        route.native_interval
        if route.kind is IntervalRouteKind.NATIVE
        else route.base_interval
    )
    base_ms = parse_interval_ms(base_interval or "") or route.spec.nominal_ms
    factor = max(1, route.spec.nominal_ms // base_ms)
    return {
        "is_custom": route.kind is IntervalRouteKind.DERIVED,
        "custom_seconds": route.spec.nominal_ms // 1000,
        "base_interval": base_interval,
        "factor": factor,
        "canonical_interval": route.canonical_interval,
        "native_interval": route.native_interval,
        "kind": route.kind.value,
        "purpose": route.purpose.value,
    }


def _bars_to_dicts(bars: list) -> list[dict]:
    """Convert bars to the enhanced Kline API contract."""
    return public_bar_rows(bars)


def _query_http_exception(exc: Exception, prefix: str) -> HTTPException:
    if isinstance(exc, IntervalResolutionError):
        return HTTPException(status_code=400, detail=exc.to_dict())
    return HTTPException(status_code=500, detail=f"{prefix}: {exc}")


def _call_data_manager_method(method: Any, *args: Any, **kwargs: Any) -> Any:
    """Call a DataManager method while tolerating older test doubles."""
    try:
        signature = inspect.signature(method)
        supports_kwargs = any(
            param.kind is inspect.Parameter.VAR_KEYWORD
            for param in signature.parameters.values()
        )
        if not supports_kwargs:
            kwargs = {
                key: value
                for key, value in kwargs.items()
                if key in signature.parameters
            }
    except (TypeError, ValueError):
        pass
    return method(*args, **kwargs)


def _backfill_request_ids(result: Any) -> list[str]:
    metadata = getattr(result, "metadata", None) or {}
    raw_ids = metadata.get("backfill_request_ids") or []
    if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
    ids: list[str] = []
    seen: set[str] = set()
    for raw_id in raw_ids:
        request_id = str(raw_id or "").strip()
        if request_id and request_id not in seen:
            ids.append(request_id)
            seen.add(request_id)
    return ids


def _consume_background_task(task: asyncio.Task[Any]) -> None:
    """Consume eventual completion without joining a cancellation-resistant task."""
    if task.cancelled():
        return
    try:
        task.exception()
    except BaseException:
        pass


async def _bounded_awaitable(
    awaitable: Awaitable[Any],
    *,
    timeout_seconds: float,
) -> tuple[bool, Any | None]:
    """Await no longer than the budget, even if cancellation is ignored."""
    task = asyncio.create_task(awaitable)
    done, _ = await asyncio.wait(
        {task},
        timeout=max(0.0, float(timeout_seconds)),
    )
    if task in done:
        return True, await task
    task.cancel()
    task.add_done_callback(_consume_background_task)
    return False, None


def _backfill_wait_tasks(
    request: Request,
    result: Any | None,
    *,
    after_revisions: dict[str, int] | None = None,
    request_ids: list[str] | None = None,
) -> set[asyncio.Task[tuple[str, dict[str, Any]]]]:
    target_ids = (
        list(request_ids)
        if request_ids is not None
        else _backfill_request_ids(result)
    )
    if not target_ids:
        return set()

    coordinator = _get_backfill_coordinator(request)
    wait_for_request = getattr(coordinator, "wait_for_request", None)
    wait_for_progress = getattr(coordinator, "wait_for_progress", None)
    if not callable(wait_for_progress) and not callable(wait_for_request):
        return set()

    revisions = after_revisions or {}

    async def _wait_one(request_id: str) -> tuple[str, dict[str, Any]]:
        try:
            if callable(wait_for_progress):
                progress = await wait_for_progress(
                    request_id,
                    after_revision=int(revisions.get(request_id, 0)),
                )
                if isinstance(progress, dict):
                    return request_id, dict(progress)
                return request_id, {"terminal": True}
            await wait_for_request(request_id)
            return request_id, {"terminal": True}
        except Exception:
            logger.debug(
                "Waiting for backfill request %s failed",
                request_id,
                exc_info=True,
            )
            return request_id, {"terminal": True, "failed": True}

    return {
        asyncio.create_task(
            _wait_one(request_id),
            name=f"kline-backfill-progress:{request_id}",
        )
        for request_id in target_ids
    }


def _new_request_demand_owner_id(
    demand_scope: str | None,
    demand_generation: int | None,
) -> str | None:
    normalized_scope = str(demand_scope or "").strip()
    if not normalized_scope or demand_generation is None:
        return None
    return (
        f"scope:{normalized_scope}:{int(demand_generation)}:"
        f"{time.monotonic_ns()}"
    )


def _request_backfill_demand_metadata(
    *,
    demand_scope: str | None,
    demand_generation: int | None,
    demand_owner_id: str | None,
) -> dict[str, Any] | None:
    normalized_scope = str(demand_scope or "").strip()
    normalized_owner = str(demand_owner_id or "").strip()
    if not normalized_scope or demand_generation is None or not normalized_owner:
        return None
    return {
        "demand_owner_id": normalized_owner,
        "demand_scope": normalized_scope,
        "demand_generation": int(demand_generation),
    }


async def _revoke_request_demand_owner(
    request: Request,
    demand_owner_id: str | None,
    *,
    reason: str,
) -> None:
    normalized_owner = str(demand_owner_id or "").strip()
    if not normalized_owner:
        return
    coordinator = _get_backfill_coordinator(request)
    revoke_owner = getattr(coordinator, "revoke_demand_owner", None)
    if not callable(revoke_owner):
        return
    try:
        await revoke_owner(normalized_owner, reason=reason)
    except Exception:
        logger.debug(
            "Failed to revoke backfill demand owner %s",
            normalized_owner,
            exc_info=True,
        )


async def _advance_request_demand_scope(
    request: Request,
    *,
    demand_scope: str | None,
    demand_generation: int | None,
) -> bool:
    """Supersede older work for one chart pane without breaking old clients."""
    normalized_scope = str(demand_scope or "").strip()
    if not normalized_scope or demand_generation is None:
        return True
    coordinator = _get_backfill_coordinator(request)
    advance_scope = getattr(coordinator, "advance_demand_scope", None)
    if not callable(advance_scope):
        return True
    is_current = getattr(coordinator, "is_demand_generation_current", None)
    if callable(is_current) and not is_current(
        normalized_scope,
        int(demand_generation),
    ):
        return False
    try:
        await advance_scope(normalized_scope, int(demand_generation))
    except Exception:
        # Demand cancellation is an optimization/control-plane feature.  A
        # coordinator mismatch must not turn a valid history request into 500.
        logger.debug(
            "Failed to advance backfill demand scope %s@%s",
            normalized_scope,
            demand_generation,
            exc_info=True,
        )
        return True
    return not callable(is_current) or bool(is_current(
        normalized_scope,
        int(demand_generation),
    ))


async def _reject_stale_request_generation(
    request: Request,
    *,
    demand_scope: str | None,
    demand_generation: int | None,
    advance: bool = True,
) -> None:
    if advance:
        current = await _advance_request_demand_scope(
            request,
            demand_scope=demand_scope,
            demand_generation=demand_generation,
        )
    else:
        normalized_scope = str(demand_scope or "").strip()
        coordinator = _get_backfill_coordinator(request)
        is_current = getattr(coordinator, "is_demand_generation_current", None)
        current = bool(
            not normalized_scope
            or demand_generation is None
            or not callable(is_current)
            or is_current(normalized_scope, int(demand_generation))
        )
    if current:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "stale_request_generation",
            "request_scope": str(demand_scope or "").strip(),
            "request_generation": demand_generation,
        },
    )


async def _acquire_scope_demand_for_result(
    request: Request,
    result: Any,
    *,
    demand_scope: str | None,
    demand_generation: int | None,
    demand_owner_id: str | None = None,
) -> None:
    """Attach cancellable scope ownership even when the API does not wait."""
    normalized_scope = str(demand_scope or "").strip()
    if not normalized_scope or demand_generation is None:
        return
    request_ids = _backfill_request_ids(result)
    if not request_ids:
        return
    coordinator = _get_backfill_coordinator(request)
    acquire_demand = getattr(coordinator, "acquire_demand", None)
    if not callable(acquire_demand):
        return
    owner_id = str(demand_owner_id or "").strip() or (
        f"scope:{normalized_scope}:{int(demand_generation)}:{time.monotonic_ns()}"
    )
    for request_id in request_ids:
        try:
            await acquire_demand(
                request_id,
                owner_id=owner_id,
                scope=normalized_scope,
                generation=int(demand_generation),
            )
        except Exception:
            logger.debug(
                "Failed to attach scope demand %s to %s",
                owner_id,
                request_id,
                exc_info=True,
            )


async def _request_disconnected(request: Request) -> bool:
    if bool(getattr(request.state, "backfill_wait_disconnected", False)):
        return True
    is_disconnected = getattr(request, "is_disconnected", None)
    if not callable(is_disconnected):
        return False
    try:
        return bool(await is_disconnected())
    except Exception:
        return False


async def _poll_backfill_storage(
    request: Request,
    result: Any,
    *,
    timeout_seconds: float,
    requery: Callable[[bool], Awaitable[Any]],
    wait_through_partial_rows: bool = False,
    coalesce_nonterminal_progress: bool = False,
    ready: Callable[[Any], bool] | None = None,
    demand_scope: str | None = None,
    demand_generation: int | None = None,
    demand_owner_id: str | None = None,
) -> Any:
    """Wait on exact repairs and re-query only on completion or timeout.

    Empty cold starts can return as soon as any rows appear.  A partial range
    with a known tail/interior repair must instead keep waiting for the exact
    repair future (within the same bounded budget), otherwise the API returns
    the known incomplete history immediately.  When exact request ids are not
    available, retain the legacy bounded polling fallback.  Derived-interval
    callers may coalesce non-terminal chunk progress so an expensive base-bar
    aggregation runs once at terminal publication or timeout, rather than once
    for every physical exchange page.
    """
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    coordinator = _get_backfill_coordinator(request)
    request_ids = _backfill_request_ids(result)
    owner_id = f"http:{id(request)}:{time.monotonic_ns()}"
    normalized_scope = str(demand_scope or "").strip() or None
    scope_owner_id = str(demand_owner_id or "").strip() or (
        (
            f"scope:{normalized_scope}:{int(demand_generation)}:"
            f"{time.monotonic_ns()}"
        )
        if normalized_scope is not None and demand_generation is not None
        else None
    )
    acquire_demand = getattr(coordinator, "acquire_demand", None)
    release_demand = getattr(coordinator, "release_demand", None)
    leased_ids: list[str] = []
    scope_leased_ids: list[str] = []
    if callable(acquire_demand):
        for request_id in request_ids:
            if scope_owner_id is not None:
                try:
                    scope_acquired = await acquire_demand(
                        request_id,
                        owner_id=scope_owner_id,
                        scope=normalized_scope,
                        generation=demand_generation,
                    )
                except Exception:
                    scope_acquired = False
                if scope_acquired:
                    scope_leased_ids.append(request_id)
                else:
                    # The coordinator rejects a generation that lost a race
                    # with a newer pane request. Do not resurrect it with an
                    # independent HTTP lease.
                    continue
            try:
                acquired = await acquire_demand(
                    request_id,
                    owner_id=owner_id,
                    scope=normalized_scope,
                    generation=demand_generation,
                )
            except Exception:
                acquired = False
            if acquired:
                leased_ids.append(request_id)

    progress_for_request = getattr(coordinator, "progress_for_request", None)
    revisions: dict[str, int] = {}
    if callable(progress_for_request):
        for request_id in request_ids:
            progress = progress_for_request(request_id)
            if isinstance(progress, dict):
                revisions[request_id] = int(progress.get("revision", 0) or 0)

    wait_tasks = _backfill_wait_tasks(
        request,
        result,
        after_revisions=revisions,
    )
    disconnected = False
    latest_chunk_progress: dict[str, Any] | None = None

    async def _wait_for_disconnect() -> bool:
        is_disconnected = getattr(request, "is_disconnected", None)
        if not callable(is_disconnected):
            await asyncio.Future()
            return False
        while True:
            if await is_disconnected():
                return True
            await asyncio.sleep(0.05)

    disconnect_task = asyncio.create_task(
        _wait_for_disconnect(),
        name="kline-backfill-disconnect-probe",
    )
    try:
        while True:
            remaining = deadline - time.monotonic()
            resume_request_ids: list[str] = []
            saw_terminal_progress = False
            wait_budget_expired = False
            if wait_tasks:
                done: set[asyncio.Task] = set()
                if remaining > 0:
                    done, pending = await asyncio.wait(
                        {*wait_tasks, disconnect_task},
                        timeout=remaining,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if disconnect_task in done:
                        disconnected = True
                        return result
                    if not done:
                        wait_budget_expired = True
                    wait_tasks = {
                        task for task in pending if task is not disconnect_task
                    }
                for task in done:
                    if task is disconnect_task:
                        continue
                    # A terminal coordinator state is only a signal to inspect
                    # storage. It cannot prove that the committed rows satisfy
                    # coverage or trusted-finality publication requirements.
                    request_id, progress = await task
                    revisions[request_id] = max(
                        int(revisions.get(request_id, 0)),
                        int(progress.get("revision", 0) or 0),
                    )
                    if int(progress.get("completed_chunk_target_bars", 0) or 0) > 0:
                        latest_chunk_progress = dict(progress)
                    if bool(progress.get("terminal")):
                        saw_terminal_progress = True
                    else:
                        resume_request_ids.append(request_id)
            elif remaining > 0:
                done, _ = await asyncio.wait(
                    {disconnect_task},
                    timeout=min(0.2, remaining),
                )
                if disconnect_task in done:
                    disconnected = True
                    return result

            # While exact requests are pending, inspect storage only when one
            # finishes or the budget expires. If all requests terminate but
            # publication is still not ready, bounded polling remains active:
            # a coordinator completion may precede a visible durable commit.
            remaining_after_wait = deadline - time.monotonic()
            if (
                coalesce_nonterminal_progress
                and wait_through_partial_rows
                and resume_request_ids
                and not saw_terminal_progress
                and not wait_budget_expired
                and remaining_after_wait > 0
            ):
                wait_tasks.update(_backfill_wait_tasks(
                    request,
                    None,
                    after_revisions=revisions,
                    request_ids=resume_request_ids,
                ))
                continue
            requery_budget = (
                BACKFILL_FINAL_REQUERY_GRACE_SECONDS
                if wait_budget_expired or remaining_after_wait <= 0
                else min(
                    BACKFILL_REQUERY_MAX_SECONDS,
                    max(0.05, remaining_after_wait),
                )
            )
            requery_completed, requeried = await _bounded_awaitable(
                requery(False),
                timeout_seconds=requery_budget,
            )
            if not requery_completed:
                logger.warning(
                    "Backfill storage requery exceeded %.3fs; returning bounded result",
                    requery_budget,
                )
                return result
            result = requeried
            if latest_chunk_progress is not None:
                metadata = getattr(result, "metadata", None)
                if isinstance(metadata, dict):
                    metadata["backfill_progress"] = dict(latest_chunk_progress)
            result_ready = (
                bool(ready(result))
                if ready is not None
                else bool(result.bars and not wait_through_partial_rows)
            )
            if wait_budget_expired or time.monotonic() >= deadline or result_ready:
                return result
            if resume_request_ids:
                wait_tasks.update(_backfill_wait_tasks(
                    request,
                    None,
                    after_revisions=revisions,
                    request_ids=resume_request_ids,
                ))
    except asyncio.CancelledError:
        # ASGI request cancellation is the common AbortSignal path. Treat it
        # exactly like an explicit disconnect so the last demand can stop at
        # the next physical chunk boundary.
        disconnected = True
        raise
    finally:
        if disconnected:
            request.state.backfill_wait_disconnected = True
        disconnect_task.cancel()
        for wait_task in wait_tasks:
            wait_task.cancel()

        cleanup_tasks: set[asyncio.Task[Any]] = {
            disconnect_task,
            *wait_tasks,
        }
        if disconnected and scope_owner_id is not None:
            cleanup_tasks.add(asyncio.create_task(
                _revoke_request_demand_owner(
                    request,
                    scope_owner_id,
                    reason="http_disconnected",
                )
            ))

        async def _release_one(
            request_id: str,
            *,
            owner_id: str,
            cancel_if_unobserved: bool,
            reason: str,
        ) -> None:
            if not callable(release_demand):
                return
            try:
                await release_demand(
                    request_id,
                    owner_id=owner_id,
                    cancel_if_unobserved=cancel_if_unobserved,
                    reason=reason,
                )
            except Exception:
                logger.debug(
                    "Failed to release backfill demand %s",
                    request_id,
                    exc_info=True,
                )

        if callable(release_demand):
            for request_id in leased_ids:
                cleanup_tasks.add(asyncio.create_task(_release_one(
                    request_id,
                    owner_id=owner_id,
                    cancel_if_unobserved=disconnected,
                    reason=(
                        "http_disconnected"
                        if disconnected
                        else "http_wait_complete"
                    ),
                )))
            if disconnected and scope_owner_id is not None:
                for request_id in scope_leased_ids:
                    cleanup_tasks.add(asyncio.create_task(_release_one(
                        request_id,
                        owner_id=scope_owner_id,
                        cancel_if_unobserved=True,
                        reason="http_disconnected",
                    )))

        if cleanup_tasks:
            done, pending = await asyncio.wait(
                cleanup_tasks,
                timeout=BACKFILL_CLEANUP_GRACE_SECONDS,
            )
            for task in done:
                _consume_background_task(task)
            for task in pending:
                # Cleanup includes demand revoke/release mutations.  Cancelling
                # one after it has removed scheduler ownership but before its
                # durable finalizer completes can strand a zombie request.
                # The request deadline stays bounded by detaching overdue
                # cleanup and consuming its eventual result.
                task.add_done_callback(_consume_background_task)
            if pending:
                logger.warning(
                    "Backfill cleanup exceeded %.3fs; detached pending tasks=%s",
                    BACKFILL_CLEANUP_GRACE_SECONDS,
                    [task.get_name() for task in pending],
                )


def _last_closed_open_ms(
    interval: str,
    now_ms: int | None = None,
    calendar: TradingCalendar | None = None,
) -> int:
    """Return the latest closed bar open_time for an interval."""
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    if calendar is not None:
        return latest_closed_expected_open_ms(calendar, now, interval) or 0
    return last_closed_bar_open_ms(now, interval) or 0


def _should_wait_for_backfill(result: Any) -> bool:
    """Return whether a response has a scheduled repair worth bounded waiting."""
    if not bool(getattr(result, "backfill_triggered", False)):
        return False
    if not getattr(result, "bars", None):
        return True
    return bool(
        getattr(result, "has_tail_gap", False)
        or getattr(result, "missing_ranges", None)
    )


def _first_expected_open_ms(start_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    bucket = compute_bucket_start_ms(start_ms, interval_ms, interval=interval)
    if bucket < start_ms:
        bucket = compute_bucket_end_ms(bucket, interval_ms, interval=interval)
    return bucket


def _next_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_end_ms(open_ms, interval_ms, interval=interval)


def _previous_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_start_ms(open_ms - 1, interval_ms, interval=interval)


def _bounded_latest_tail_range(
    *,
    interval: str,
    limit: int,
    calendar: TradingCalendar | None,
) -> tuple[int, int]:
    """Plan only the newest closed buckets for opt-in latest repair.

    This helper is deliberately synchronous and runs on the storage executor:
    third-party/session calendar iteration can be CPU-heavy and must not block
    the ASGI event loop.
    """

    tail_end_ms = _last_closed_open_ms(interval, calendar=calendar)
    tail_start_ms = tail_end_ms
    if calendar is not None:
        lookback_ms = min(
            tail_end_ms,
            max(
                7 * 86_400_000,
                limit * max(_interval_ms_for_request(interval), 60_000) * 4,
            ),
        )
        recent_opens: deque[int] = deque(maxlen=limit)
        while True:
            search_start_ms = max(0, tail_end_ms - lookback_ms)
            recent_opens.clear()
            for open_ms in calendar.expected_opens(
                search_start_ms,
                tail_end_ms,
                interval,
            ):
                recent_opens.append(int(open_ms))
            if len(recent_opens) >= limit or search_start_ms == 0:
                break
            lookback_ms = min(tail_end_ms, max(lookback_ms + 1, lookback_ms * 2))
        if recent_opens:
            tail_start_ms = recent_opens[0]
    elif is_monthly_interval(interval):
        for _ in range(limit - 1):
            if tail_start_ms <= 0:
                break
            previous = _previous_expected_open_ms(tail_start_ms, interval)
            if previous < 0 or previous >= tail_start_ms:
                break
            tail_start_ms = previous
    else:
        tail_start_ms = max(
            0,
            tail_end_ms - ((limit - 1) * _interval_ms_for_request(interval)),
        )
    return tail_start_ms, tail_end_ms


def _interval_ms_for_request(interval: str) -> int:
    interval_ms = parse_interval_ms(interval)
    if interval_ms is not None and interval_ms > 0:
        return interval_ms
    custom_seconds = parse_custom_interval(interval) or 60
    return int(custom_seconds * 1000)


def _resolve_history_calendar(
    dm: Any,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
) -> tuple[TradingCalendar | None, bool]:
    resolver = getattr(dm, "history_policy", None)
    if resolver is None:
        return None, True
    try:
        key = resolver.series_key(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            channel="kline",
            variant=interval,
        )
        context = resolver.resolve(key)
        return context.calendar, context.calendar is not None
    except Exception as exc:
        logger.warning(
            "Unable to resolve history calendar for %s:%s:%s@%s: %s",
            exchange,
            market_type,
            symbol,
            interval,
            exc,
        )
        return None, False


def _history_contract_payload(
    result: Any,
    *,
    verified_contiguous: bool | None = None,
    missing_ranges: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Serialize the additive terminal/pending history contract."""
    metadata = dict(getattr(result, "metadata", None) or {})
    raw_all_rows_final = metadata.get("all_rows_final")
    all_rows_final = bool(raw_all_rows_final) if raw_all_rows_final is not None else False
    payload = {
        "history_state": getattr(result, "history_state", "ready"),
        "complete": bool(getattr(result, "complete", False)),
        "retryable": bool(getattr(result, "retryable", False)),
        "terminal_reason": getattr(result, "terminal_reason", None),
        "earliest_available_ms": getattr(result, "earliest_available_ms", None),
        "next_before_ms": getattr(result, "next_before_ms", None),
        "availability_revision": getattr(result, "availability_revision", None),
        "excluded_ranges": list(getattr(result, "excluded_ranges", ()) or ()),
        "retry_at_ms": metadata.get("backfill_retry_at_ms"),
        "all_rows_final": all_rows_final,
    }
    observed_missing = (
        list(getattr(result, "missing_ranges", ()) or ())
        if missing_ranges is None
        else missing_ranges
    )
    # API-level exact verification is authoritative for the returned range and
    # can find a gap that a count-based result alone cannot express.  A known
    # terminal edge may stop pagination farther left, but it cannot mark a
    # repairable hole inside the returned fetchable window as complete.
    if (
        verified_contiguous is False
        or bool(observed_missing)
        or not all_rows_final
    ):
        payload.update({
            "history_state": "pending",
            "complete": False,
            "retryable": True,
        })
    elif (
        verified_contiguous is True
        and all_rows_final
        and payload["history_state"] == "ready"
        and not observed_missing
    ):
        payload.update({"complete": True, "retryable": False})
    return payload


def _all_rows_final(result: Any) -> bool:
    """Return the QueryEngine finality verdict without inferring from OHLCV."""
    metadata = dict(getattr(result, "metadata", None) or {})
    value = metadata.get("all_rows_final")
    return bool(value) if value is not None else False


def _history_page_finality_ready(result: Any) -> bool:
    """Require proven final rows and no remaining repair work."""
    return bool(
        _all_rows_final(result)
        and not getattr(result, "missing_ranges", None)
        and not getattr(result, "has_tail_gap", False)
        and getattr(result, "history_state", "pending") != "pending"
        and not getattr(result, "retryable", False)
    )


def _returned_history_page_ready(
    result: Any,
    *,
    symbol: str,
    interval: str,
    exchange: str,
    market_type: str,
    calendar: TradingCalendar | None,
    calendar_known: bool,
) -> bool:
    """Allow a cold request to publish the first final contiguous chunk.

    Missing work outside the returned page remains visible through the normal
    history contract, so the client can render useful candles immediately and
    continue paging/retrying while the parent repair advances chunk by chunk.
    """
    if not getattr(result, "bars", None) or not _all_rows_final(result):
        return False
    data = _bars_to_dicts(result.bars)
    metadata = dict(getattr(result, "metadata", None) or {})
    progress = metadata.get("backfill_progress")
    if not isinstance(progress, dict):
        return False
    required_bars = int(progress.get("completed_chunk_target_bars", 0) or 0)
    # A progress wake-up may race a stale/terminal coordinator snapshot. Only
    # a complete physical chunk is a meaningful first paint boundary.
    if required_bars <= 0 or len(data) < required_bars:
        return False
    opens = [
        int(item["time"]) * 1000
        for item in data
        if item.get("time") is not None
    ]
    if not opens:
        return False
    verification = _verify_range_continuity(
        data=data,
        symbol=symbol,
        interval=interval,
        exchange=exchange,
        market_type=market_type,
        start_ms=min(opens),
        end_ms=max(opens),
        calendar=calendar,
        calendar_known=calendar_known,
        excluded_ranges=getattr(result, "excluded_ranges", None),
    )
    return bool(verification["verified_contiguous"])


def _cap_range_request(
    *,
    start_ms: int,
    end_ms: int,
    interval: str,
    max_bars: int = MAX_RANGE_RESPONSE_BARS,
    calendar: TradingCalendar | None = None,
) -> dict[str, Any]:
    interval_ms = _interval_ms_for_request(interval)
    if interval_ms <= 0 or end_ms < start_ms:
        return {
            "query_start_ms": start_ms,
            "query_end_ms": end_ms,
            "needed_limit": 0,
            "truncated": False,
            "next_end_ms": None,
            "interval_ms": interval_ms,
        }

    if calendar is not None:
        # Canonicalise an arbitrary inclusive edge to its containing expected
        # bucket.  Strict stepping with ``end_ms + 1`` leaks that +1 offset on
        # always-open calendars for non-standard widths such as 47m.
        last_open = containing_expected_open_ms(calendar, int(end_ms), interval)
        if last_open is None or last_open < start_ms:
            requested_bars = 0
            query_start_ms = start_ms
            next_older_open = None
        else:
            requested_bars = 1
            query_start_ms = last_open
            while requested_bars < max_bars:
                previous = calendar.previous_expected_open(query_start_ms, interval)
                if previous is None or previous < start_ms:
                    break
                query_start_ms = previous
                requested_bars += 1
            next_older_open = calendar.previous_expected_open(query_start_ms, interval)
        truncated = bool(
            requested_bars >= max_bars
            and next_older_open is not None
            and next_older_open >= start_ms
        )
        if truncated:
            return {
                "query_start_ms": query_start_ms,
                "query_end_ms": end_ms,
                "needed_limit": max_bars,
                "truncated": True,
                "next_end_ms": next_older_open,
                "interval_ms": interval_ms,
            }
    elif is_monthly_interval(interval):
        last_open = compute_bucket_start_ms(
            end_ms,
            interval_ms,
            interval=interval,
        )
        if last_open < start_ms:
            requested_bars = 0
            query_start_ms = start_ms
            next_older_open = None
        else:
            requested_bars = 1
            query_start_ms = last_open
            while requested_bars < max_bars:
                previous = _previous_expected_open_ms(query_start_ms, interval)
                if previous < start_ms:
                    break
                query_start_ms = previous
                requested_bars += 1
            next_older_open = _previous_expected_open_ms(query_start_ms, interval)
        truncated = bool(
            requested_bars >= max_bars
            and next_older_open is not None
            and next_older_open >= start_ms
        )
        if truncated:
            return {
                "query_start_ms": query_start_ms,
                "query_end_ms": end_ms,
                "needed_limit": max_bars,
                "truncated": True,
                "next_end_ms": next_older_open,
                "interval_ms": interval_ms,
            }
    else:
        requested_bars = int((end_ms - start_ms) / interval_ms) + 1
    if requested_bars <= max_bars:
        return {
            "query_start_ms": start_ms,
            "query_end_ms": end_ms,
            "needed_limit": min(max_bars, max(0, requested_bars - 1) + 100),
            "truncated": False,
            "next_end_ms": None,
            "interval_ms": interval_ms,
        }

    query_start_ms = max(start_ms, end_ms - ((max_bars - 1) * interval_ms))
    next_end_ms = query_start_ms - interval_ms if query_start_ms > start_ms else None
    return {
        "query_start_ms": query_start_ms,
        "query_end_ms": end_ms,
        "needed_limit": max_bars,
        "truncated": True,
        "next_end_ms": next_end_ms,
        "interval_ms": interval_ms,
    }


def _verify_range_continuity(
    *,
    data: list[dict],
    symbol: str,
    interval: str,
    exchange: str,
    market_type: str,
    start_ms: int,
    end_ms: int,
    calendar: TradingCalendar | None = None,
    calendar_known: bool = True,
    excluded_ranges: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Verify exact closed-bar continuity for a range returned to the chart."""
    if not calendar_known:
        return {
            "verified_contiguous": False,
            "missing_ranges": [],
            "expected_bars": 0,
            "actual_bars": len(data),
            "calendar_unknown": True,
        }

    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0 or start_ms > end_ms:
        return {
            "verified_contiguous": True,
            "missing_ranges": [],
            "expected_bars": 0,
            "actual_bars": len(data),
        }

    actual = {int(item["time"]) * 1000 for item in data if item.get("time") is not None}
    closed_actual = {
        int(item["time"]) * 1000
        for item in data
        if item.get("time") is not None and item.get("is_closed") is not False
    }
    exclusions: list[tuple[int, int]] = []
    for item in excluded_ranges or []:
        try:
            excluded_start = int(item["start_ms"])
            excluded_end = int(item["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if excluded_start <= excluded_end:
            exclusions.append((excluded_start, excluded_end))

    def _is_excluded(open_ms: int, bucket_end_ms: int) -> bool:
        # A custom candle is unverifiable when any suppressed durable base
        # component overlaps its bucket.  Point-only checks at the custom open
        # would miss (for example) a suppressed 15m component at +30m.
        return any(start <= bucket_end_ms and end >= open_ms for start, end in exclusions)

    current = (
        calendar.first_expected_open(start_ms, end_ms, interval)
        if calendar is not None
        else _first_expected_open_ms(start_ms, interval)
    )
    missing: list[dict[str, Any]] = []
    range_start: int | None = None
    range_end: int | None = None
    range_count = 0
    expected_count = 0

    def _flush_missing_range() -> None:
        nonlocal range_start, range_end, range_count
        if range_start is not None and range_end is not None:
            missing.append({
                "symbol": symbol.upper(),
                "interval": interval,
                "exchange": exchange,
                "market_type": market_type,
                "start_ms": range_start,
                "end_ms": range_end,
                "missing_bars": range_count,
                "reason": "range_verification",
                "status": "detected",
            })
        range_start = None
        range_end = None
        range_count = 0

    while current is not None and current <= end_ms:
        next_open = (
            calendar.next_expected_open(current, interval)
            if calendar is not None
            else _next_expected_open_ms(current, interval)
        )
        bucket_end = (
            expected_bucket_end_ms(calendar, current, interval) - 1
            if calendar is not None
            else (
                next_open - 1
                if next_open is not None and next_open > current
                else current
            )
        )
        if _is_excluded(current, bucket_end):
            # A terminal/cooldown bucket is a continuity boundary.  Keeping an
            # active run across it would submit one covering repair range that
            # includes the suppressed bucket and bypasses exact ledger lookup.
            _flush_missing_range()
            current = next_open
            continue
        expected_count += 1
        if current not in closed_actual:
            if range_start is None:
                range_start = current
                range_count = 0
            range_end = current
            range_count += 1
        elif range_start is not None:
            _flush_missing_range()
        current = next_open

    _flush_missing_range()

    return {
        "verified_contiguous": not missing,
        "missing_ranges": missing,
        "expected_bars": expected_count,
        "actual_bars": len(actual),
        "unclosed_bars": len(actual - closed_actual),
        "calendar_unknown": False,
    }


def _merge_missing_ranges(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[int, int], dict[str, Any]] = {}
    for group in groups:
        for item in group:
            try:
                key = (int(item["start_ms"]), int(item["end_ms"]))
            except (KeyError, TypeError, ValueError):
                continue
            existing = merged.get(key)
            if existing is None:
                merged[key] = dict(item)
                continue
            if existing.get("missing_bars") is None and item.get("missing_bars") is not None:
                existing["missing_bars"] = item["missing_bars"]
            if existing.get("reason") == "range_verification" and item.get("reason"):
                existing["reason"] = item["reason"]
    return sorted(merged.values(), key=lambda item: (item["start_ms"], item["end_ms"]))


def _verification_only_missing_ranges(
    verification_missing: list[dict[str, Any]],
    reported_missing: list[dict[str, Any]],
    *,
    interval: str,
    calendar: TradingCalendar | None,
) -> list[dict[str, Any]]:
    """Return verifier gaps not already covered by QueryEngine reports.

    QueryEngine-owned ranges have already gone through DataManager's normal
    submission path.  Work at expected-open granularity so a partially
    overlapping report submits only the uncovered portion, including for
    session-aware calendars and calendar-width intervals.
    """
    reported_bounds: list[tuple[int, int]] = []
    for item in reported_missing:
        try:
            start_ms = int(item["start_ms"])
            end_ms = int(item["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if start_ms <= end_ms:
            reported_bounds.append((start_ms, end_ms))

    uncovered: list[dict[str, Any]] = []
    for item in verification_missing:
        try:
            item_start = int(item["start_ms"])
            item_end = int(item["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if item_start > item_end:
            continue

        range_start: int | None = None
        range_end: int | None = None
        range_count = 0
        current: int | None = item_start
        while current is not None and current <= item_end:
            next_open = (
                calendar.next_expected_open(current, interval)
                if calendar is not None
                else _next_expected_open_ms(current, interval)
            )
            bucket_end = (
                expected_bucket_end_ms(calendar, current, interval) - 1
                if calendar is not None
                else (
                    next_open - 1
                    if next_open is not None and next_open > current
                    else current
                )
            )
            # Custom interval queries report the actionable missing component
            # in its durable base interval.  Any overlap inside this target
            # bucket is already submitted by DataManager and must not schedule
            # a second, unsupported custom-interval provider request.
            covered = any(
                start <= bucket_end and end >= current
                for start, end in reported_bounds
            )
            if covered:
                if range_start is not None and range_end is not None:
                    missing = dict(item)
                    missing.update({
                        "start_ms": range_start,
                        "end_ms": range_end,
                        "missing_bars": range_count,
                    })
                    uncovered.append(missing)
                    range_start = None
                    range_end = None
                    range_count = 0
            else:
                if range_start is None:
                    range_start = current
                range_end = current
                range_count += 1

            if next_open is None or next_open <= current:
                break
            current = next_open

        if range_start is not None and range_end is not None:
            missing = dict(item)
            missing.update({
                "start_ms": range_start,
                "end_ms": range_end,
                "missing_bars": range_count,
            })
            uncovered.append(missing)
    return uncovered


def _attach_backfill_request_ids(result: Any, request_ids: list[str]) -> None:
    if not request_ids:
        return
    metadata = dict(getattr(result, "metadata", None) or {})
    known = _backfill_request_ids(result)
    metadata["backfill_request_ids"] = list(dict.fromkeys([*known, *request_ids]))
    result.metadata = metadata


def _submit_verification_repairs(
    dm: Any,
    missing_ranges: list[dict[str, Any]],
    *,
    reason: str,
    requester: str,
    demand_metadata: dict[str, Any] | None = None,
    series_identity: KlineSeriesIdentity | None = None,
) -> tuple[int, list[str], list[dict[str, Any]]]:
    """Submit exact API-only gaps through the normal DataManager facade."""
    request_backfill = getattr(dm, "request_backfill", None)
    suppression_lookup = getattr(dm, "get_backfill_suppression", None)
    if not callable(request_backfill) and not callable(suppression_lookup):
        return 0, [], []

    submitted = 0
    request_ids: list[str] = []
    suppressions: list[dict[str, Any]] = []
    for missing in missing_ranges:
        if callable(suppression_lookup):
            try:
                suppression = _call_data_manager_method(
                    suppression_lookup,
                    str(missing["symbol"]),
                    str(missing["interval"]),
                    int(missing["start_ms"]),
                    int(missing["end_ms"]),
                    str(missing["exchange"]),
                    str(missing["market_type"]),
                )
            except Exception:
                suppression = None
                logger.warning("Verification-only suppression lookup failed", exc_info=True)
            if isinstance(suppression, dict):
                suppressions.append({
                    **suppression,
                    "requested_start_ms": int(missing["start_ms"]),
                    "requested_end_ms": int(missing["end_ms"]),
                })
                continue
        if not callable(request_backfill):
            continue
        try:
            metadata = {
                "query_reason": "range_verification",
                "verification_only": True,
                "requested_range": {
                    "start_ms": int(missing["start_ms"]),
                    "end_ms": int(missing["end_ms"]),
                },
                "missing_bars": missing.get("missing_bars"),
                **dict(demand_metadata or {}),
            }
            if (
                series_identity is not None
                and not series_identity.is_legacy_default_for(
                    str(missing["exchange"])
                )
            ):
                # These fields select the physical storage partition and its
                # verification contract. Callers may add annotations, but
                # must not redirect a repair into a different series.
                metadata.update({
                    "series_identity": series_identity.to_dict(),
                    "history_verification": "provider_authoritative_sparse",
                    "requires_trusted_finality": True,
                })
            outcome = _call_data_manager_method(
                request_backfill,
                str(missing["symbol"]),
                str(missing["interval"]),
                int(missing["start_ms"]),
                int(missing["end_ms"]),
                str(missing["exchange"]),
                str(missing["market_type"]),
                reason=reason,
                requester=requester,
                metadata=metadata,
            )
        except Exception:
            logger.warning(
                "Failed to submit verification-only K-line repair for %s:%s:%s@%s %s-%s",
                missing.get("exchange"),
                missing.get("market_type"),
                missing.get("symbol"),
                missing.get("interval"),
                missing.get("start_ms"),
                missing.get("end_ms"),
                exc_info=True,
            )
            continue
        # Current DataManager returns bool; coordinator-aware/test facades may
        # return an exact request id.  A legacy command returning None is still
        # considered accepted if it completed without raising.
        if outcome is False:
            continue
        submitted += 1
        if isinstance(outcome, str) and outcome.strip():
            request_ids.append(outcome.strip())
    return submitted, request_ids, suppressions


def _attach_verification_suppressions(
    result: Any,
    suppressions: list[dict[str, Any]],
) -> None:
    if not suppressions:
        return
    metadata = dict(getattr(result, "metadata", None) or {})
    existing_suppressions = list(metadata.get("backfill_suppressions") or [])
    metadata["backfill_suppressions"] = [*existing_suppressions, *suppressions]
    retry_deadlines = [
        int(item["retry_at_ms"])
        for item in suppressions
        if item.get("retry_at_ms") is not None
    ]
    if retry_deadlines:
        current = metadata.get("backfill_retry_at_ms")
        metadata["backfill_retry_at_ms"] = min(
            [*retry_deadlines, *([] if current is None else [int(current)])],
        )
    result.metadata = metadata

    exclusions = list(getattr(result, "excluded_ranges", ()) or ())
    known = {
        (item.get("start_ms"), item.get("end_ms"), item.get("reason"))
        for item in exclusions
        if isinstance(item, dict)
    }
    for item in suppressions:
        exclusion = {
            "start_ms": int(item["requested_start_ms"]),
            "end_ms": int(item["requested_end_ms"]),
            "disposition": "terminal",
            "reason": f"gap_ledger_{item.get('ledger_status') or 'suppressed'}",
            "ledger_status": item.get("ledger_status"),
            "retry_at_ms": item.get("retry_at_ms"),
        }
        identity = (
            exclusion["start_ms"],
            exclusion["end_ms"],
            exclusion["reason"],
        )
        if identity not in known:
            exclusions.append(exclusion)
            known.add(identity)
    result.excluded_ranges = exclusions


def _related_warmup_intervals(
    current_interval: str,
    *,
    limit: int = RELATED_WARMUP_MAX_INTERVALS,
) -> list[str]:
    if current_interval not in RELATED_WARMUP_INTERVALS:
        return []

    current_index = RELATED_WARMUP_INTERVALS.index(current_interval)
    candidates: list[tuple[int, int, str]] = []
    for index, interval in enumerate(RELATED_WARMUP_INTERVALS):
        if interval == current_interval:
            continue
        distance = abs(index - current_index)
        direction_bias = 0 if index < current_index else 1
        candidates.append((distance, direction_bias, interval))
    return [interval for _, _, interval in sorted(candidates)[:limit]]


def _schedule_related_interval_warmup(
    dm: Any,
    *,
    symbol: str,
    current_interval: str,
    start_ms: int,
    end_ms: int,
    exchange: str,
    market_type: str,
    coordinator: Any | None = None,
    demand_scope: str | None = None,
    demand_generation: int | None = None,
    demand_owner_id: str | None = None,
    defer_seconds: float = 0.0,
    warmup_scheduler: RelatedIntervalWarmupScheduler | None = None,
) -> None:
    request_backfill = getattr(dm, "request_backfill", None)
    if request_backfill is None:
        return

    normalized_scope = str(demand_scope or "").strip() or None
    delay = max(0.0, float(defer_seconds))

    def _is_current() -> bool:
        if normalized_scope is not None and demand_generation is not None:
            is_current = getattr(
                coordinator,
                "is_demand_generation_current",
                None,
            )
            if callable(is_current) and not is_current(
                normalized_scope,
                demand_generation,
            ):
                return False
        return True

    def _foreground_busy() -> bool:
        # Related history is entirely speculative. Wait behind both visible
        # demand and maintenance/network work; otherwise a daily-open refresh
        # or audit can become a second upstream burst immediately after paint.
        has_backfill_work = getattr(coordinator, "has_backfill_work", None)
        if callable(has_backfill_work) and has_backfill_work():
            return True
        has_foreground_work = getattr(coordinator, "has_foreground_work", None)
        return bool(
            callable(has_foreground_work)
            and has_foreground_work()
        )

    def _foreground_idle_seconds() -> float:
        foreground_idle_seconds = getattr(coordinator, "foreground_idle_seconds", None)
        if not callable(foreground_idle_seconds):
            return float("inf")
        return float(foreground_idle_seconds())

    def _prepare() -> tuple[RelatedWarmupSubmission, ...]:
        if not _is_current():
            return ()

        submissions: list[RelatedWarmupSubmission] = []

        for interval in _related_warmup_intervals(current_interval):
            try:
                interval_ms = _interval_ms_for_request(interval)
                # ``end_ms`` is closed for the chart's current interval, but it
                # can still fall inside a forming candle of a wider related
                # interval. Recompute the live edge for each target interval.
                warmup_calendar, _ = _resolve_history_calendar(
                    dm,
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                )
                warmup_end_ms = min(
                    end_ms,
                    _last_closed_open_ms(interval, calendar=warmup_calendar),
                )
                visible_span_ms = max(0, end_ms - start_ms)
                viewport_target_bars = max(
                    1,
                    (visible_span_ms // interval_ms) + 1,
                )
                target_bars = min(
                    RELATED_WARMUP_MAX_TARGET_BARS,
                    viewport_target_bars,
                )
                warmup_start_ms = max(
                    start_ms,
                    warmup_end_ms - ((target_bars - 1) * interval_ms),
                )
                warmup_start_ms = min(warmup_start_ms, warmup_end_ms)
                planned_bars = max(
                    1,
                    ((warmup_end_ms - warmup_start_ms) // interval_ms) + 1,
                )
                metadata: dict[str, Any] = {
                    "focus_scope": "related",
                    "current_interval": current_interval,
                    "requested_interval": interval,
                    "visible_range": {
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                    },
                    "warmup_range": {
                        "start_ms": warmup_start_ms,
                        "end_ms": warmup_end_ms,
                        "target_bars": planned_bars,
                        "max_target_bars": RELATED_WARMUP_MAX_TARGET_BARS,
                    },
                }
                if normalized_scope is not None and demand_generation is not None:
                    metadata.update({
                        "demand_owner_id": (
                            str(demand_owner_id or "").strip()
                            or (
                                f"scope:{normalized_scope}:"
                                f"{int(demand_generation)}:{time.monotonic_ns()}"
                            )
                        ),
                        "demand_scope": normalized_scope,
                        "demand_generation": int(demand_generation),
                    })

                def _submit_target(
                    *,
                    target_interval: str = interval,
                    target_start_ms: int = warmup_start_ms,
                    target_end_ms: int = warmup_end_ms,
                    target_metadata: dict[str, Any] = metadata,
                ) -> bool:
                    try:
                        result = _call_data_manager_method(
                            request_backfill,
                            symbol,
                            target_interval,
                            target_start_ms,
                            target_end_ms,
                            exchange,
                            market_type,
                            reason="related_interval_warmup",
                            requester="klines_history_related",
                            metadata=target_metadata,
                        )
                        return result is not False
                    except Exception as exc:
                        logger.warning(
                            "Failed to submit related warmup for %s@%s: %s",
                            symbol,
                            target_interval,
                            exc,
                        )
                        return False

                ttl_key = (
                    exchange.strip().lower(),
                    market_type.strip().lower(),
                    symbol.strip().upper(),
                    interval,
                    warmup_start_ms,
                    warmup_end_ms,
                )
                # A cancelled scope generation must not leave an admission
                # TTL that suppresses its successor.  Retain dedupe within a
                # generation; the BackfillCoordinator still dedupes physical
                # work if successive generations overlap.
                if normalized_scope is not None and demand_generation is not None:
                    ttl_key = (
                        "demand_scope",
                        normalized_scope,
                        int(demand_generation),
                        *ttl_key,
                    )
                submissions.append(RelatedWarmupSubmission(
                    key=ttl_key,
                    submit=_submit_target,
                ))
            except Exception as exc:
                logger.warning(
                    "Failed to plan related warmup for %s@%s: %s",
                    symbol,
                    interval,
                    exc,
                )
        return tuple(submissions)

    if delay <= 0:
        for submission in _prepare():
            submission.submit()
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # Direct synchronous callers retain the historical immediate behavior.
        for submission in _prepare():
            submission.submit()
        return

    scheduler = warmup_scheduler
    if scheduler is None:
        scheduler = getattr(dm, "_related_interval_warmup_scheduler", None)
    if not isinstance(scheduler, RelatedIntervalWarmupScheduler):
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=RELATED_WARMUP_TTL_SECONDS,
            dwell_seconds=RELATED_WARMUP_DWELL_SECONDS,
            busy_recheck_seconds=RELATED_WARMUP_BUSY_RECHECK_SECONDS,
            max_entries=RELATED_WARMUP_REGISTRY_LIMIT,
        )
        try:
            setattr(dm, "_related_interval_warmup_scheduler", scheduler)
        except Exception:
            pass
    scheduler.schedule(
        (
            normalized_scope or "unscoped",
            exchange.strip().lower(),
            market_type.strip().lower(),
            symbol.strip().upper(),
            current_interval,
        ),
        prepare=_prepare,
        is_current=_is_current,
        foreground_busy=_foreground_busy,
        foreground_idle_seconds=(
            _foreground_idle_seconds
            if callable(getattr(coordinator, "foreground_idle_seconds", None))
            else None
        ),
        dwell_seconds=delay,
    )


# ═══════════════════════════════════════════════════════════════
#  Endpoints — DataManager-powered
# ═══════════════════════════════════════════════════════════════


@router.get("/")
async def get_klines(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(500, ge=1, le=1000, description="Number of rows"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Get the latest K-line bars for a symbol/interval pair.

    Uses DataManager.query_latest() which resolves through
    Cache → Storage → Backfill automatically.
    """
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    consumer_id = f"rest:klines:{exchange}:{market_type}:{symbol}:{interval}:{id(request)}"
    stream_ensured = False
    try:
        if not identity_kwargs:
            await dm.ensure_stream(
                symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
                focus_scope="rest",
                consumer_id=consumer_id,
            )
            stream_ensured = True
        result = await run_storage(
            _call_data_manager_method,
            dm.query_latest,
            symbol,
            interval,
            limit,
            exchange,
            market_type=market_type,
            **identity_kwargs,
        )
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager query failed") from exc
    finally:
        release_stream = getattr(dm, "release_stream", None)
        if stream_ensured and callable(release_stream):
            try:
                await release_stream(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope="rest",
                    consumer_id=consumer_id,
                )
            except Exception:
                pass

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/latest")
async def get_latest_klines(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(2, ge=1, le=1000, description="Number of latest rows"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    repair: Annotated[
        Literal["none", "wait"],
        Query(description="Optionally repair the bounded closed tail before returning"),
    ] = "none",
    max_wait_ms: int = Query(
        0,
        ge=0,
        le=1500,
        description="Bounded foreground tail-repair wait; used only with repair=wait",
    ),
    request_scope: str | None = Query(
        None,
        max_length=128,
        description="Stable chart/pane scope used to supersede stale tail work",
    ),
    request_generation: int | None = Query(
        None,
        ge=0,
        description="Monotonic generation within request_scope",
    ),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Get the very latest K-line bars (typically 1-2 for live updates)."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    identity_history_supported = _series_history_supported(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        identity=series_identity,
    )
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    demand_owner_id = _new_request_demand_owner_id(
        request_scope,
        request_generation,
    )
    demand_metadata = _request_backfill_demand_metadata(
        demand_scope=request_scope,
        demand_generation=request_generation,
        demand_owner_id=demand_owner_id,
    )
    await _reject_stale_request_generation(
        request,
        demand_scope=request_scope,
        demand_generation=request_generation,
    )

    dm = _require_data_manager(request)
    bounded_tail_repair = False
    tail_start_ms = 0
    tail_end_ms = 0
    if repair == "wait" and identity_history_supported:
        tail_calendar, tail_calendar_known = _resolve_history_calendar(
            dm,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
        )
        bounded_tail_repair = tail_calendar_known
        if bounded_tail_repair:
            tail_start_ms, tail_end_ms = await run_storage(
                _bounded_latest_tail_range,
                interval=interval,
                limit=limit,
                calendar=tail_calendar,
            )
    consumer_id = f"rest:klines_latest:{exchange}:{market_type}:{symbol}:{interval}:{id(request)}"
    stream_ensured = False
    try:
        if not identity_kwargs:
            await dm.ensure_stream(
                symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
                focus_scope="rest",
                consumer_id=consumer_id,
            )
            stream_ensured = True

        async def _run_latest_query(auto_backfill: bool):
            query_method = dm.query if bounded_tail_repair else dm.query_latest
            query_args = (
                (symbol, interval)
                if bounded_tail_repair
                else (symbol, interval, limit)
            )
            return await run_storage(
                _call_data_manager_method,
                query_method,
                *query_args,
                exchange=exchange,
                market_type=market_type,
                **identity_kwargs,
                **(
                    {
                        "start_ms": tail_start_ms,
                        "end_ms": tail_end_ms,
                        "limit": limit,
                    }
                    if bounded_tail_repair
                    else {}
                ),
                auto_backfill=auto_backfill,
                backfill_reason="latest_refresh",
                backfill_requester="klines_latest",
                **(
                    {"backfill_metadata": demand_metadata}
                    if demand_metadata is not None
                    else {}
                ),
            )

        result = await _run_latest_query(bounded_tail_repair)
        backfill_triggered = bool(result.backfill_triggered)
        await _acquire_scope_demand_for_result(
            request,
            result,
            demand_scope=request_scope,
            demand_generation=request_generation,
            demand_owner_id=demand_owner_id,
        )
        await _reject_stale_request_generation(
            request,
            demand_scope=request_scope,
            demand_generation=request_generation,
            advance=False,
        )
        if (
            bounded_tail_repair
            and max_wait_ms > 0
            and _should_wait_for_backfill(result)
        ):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=max_wait_ms / 1000,
                requery=_run_latest_query,
                wait_through_partial_rows=True,
                ready=_history_page_finality_ready,
                demand_scope=request_scope,
                demand_generation=request_generation,
                demand_owner_id=demand_owner_id,
            )
            backfill_triggered = backfill_triggered or bool(
                result.backfill_triggered
            )
    except asyncio.CancelledError:
        await _revoke_request_demand_owner(
            request,
            demand_owner_id,
            reason="http_query_cancelled",
        )
        raise
    except HTTPException:
        raise
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager latest query failed") from exc
    finally:
        release_stream = getattr(dm, "release_stream", None)
        if stream_ensured and callable(release_stream):
            try:
                await release_stream(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope="rest",
                    consumer_id=consumer_id,
                )
            except Exception:
                pass

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "backfill_triggered": backfill_triggered,
        "has_tail_gap": result.has_tail_gap,
        "missing_ranges": [item.to_dict() for item in result.missing_ranges],
        **_history_contract_payload(result),
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/history")
async def get_klines_history(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    days: float = Query(7, ge=0.001, description="Historical days (supports fractional, e.g. 0.04); capped at 3650 unless count_back is provided"),
    count_back: int | None = Query(None, ge=1, le=MAX_RANGE_RESPONSE_BARS, description="Newest bar count to return; overrides days window when provided"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    intent: Annotated[
        Literal["viewport", "active_hydration"],
        Query(
            description=(
                "History demand lane: viewport is foreground; active_hydration "
                "fills the active series in the background"
            )
        ),
    ] = "viewport",
    request_scope: str | None = Query(
        None,
        max_length=128,
        description="Stable chart/pane scope used to supersede stale history work",
    ),
    request_generation: int | None = Query(
        None,
        ge=0,
        description="Monotonic generation within request_scope",
    ),
    max_wait_ms: int = Query(
        3500,
        ge=0,
        le=8000,
        description=(
            "Cold-start budget (ms) to briefly wait for an initial backfill to "
            "deliver bars before returning. Only applies when cache/storage are "
            "empty and a backfill was triggered; warm queries return immediately."
        ),
    ),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Get historical K-line bars for a time range."""
    if count_back is None and days > 3650:
        raise HTTPException(
            status_code=422,
            detail="days must be less than or equal to 3650 when count_back is omitted",
        )
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    identity_history_supported = _series_history_supported(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        identity=series_identity,
    )
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    history_reason = (
        "initial_history"
        if intent == "viewport"
        else "active_history_hydration"
    )

    dm = _require_data_manager(request)
    demand_owner_id = _new_request_demand_owner_id(
        request_scope,
        request_generation,
    )
    demand_metadata = _request_backfill_demand_metadata(
        demand_scope=request_scope,
        demand_generation=request_generation,
        demand_owner_id=demand_owner_id,
    )
    await _reject_stale_request_generation(
        request,
        demand_scope=request_scope,
        demand_generation=request_generation,
    )
    if identity_history_supported:
        calendar, calendar_known = _resolve_history_calendar(
            dm,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
        )
    else:
        calendar, calendar_known = None, False
    try:
        end_ms = min(
            int(time.time() * 1000),
            _last_closed_open_ms(interval, calendar=calendar),
        )
        interval_secs = parse_custom_interval(interval) or 60
        if count_back is not None:
            start_ms = end_ms
            if calendar is not None:
                for _ in range(count_back - 1):
                    if start_ms <= 0:
                        break
                    previous = calendar.previous_expected_open(start_ms, interval)
                    if previous is None:
                        break
                    start_ms = max(0, previous)
            elif is_monthly_interval(interval):
                for _ in range(count_back - 1):
                    if start_ms <= 0:
                        break
                    start_ms = max(
                        0,
                        _previous_expected_open_ms(start_ms, interval),
                    )
            else:
                start_ms = max(
                    0,
                    end_ms - int((count_back - 1) * interval_secs * 1000),
                )
            needed_limit = min(MAX_RANGE_RESPONSE_BARS, count_back)
        else:
            start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)
            cap = _cap_range_request(
                start_ms=start_ms,
                end_ms=end_ms,
                interval=interval,
                calendar=calendar,
            )
            start_ms = cap["query_start_ms"]
            needed_limit = cap["needed_limit"]

        async def _run_history_query(auto_backfill=None):
            return await run_storage(
                _call_data_manager_method,
                dm.query,
                symbol, interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=needed_limit,
                exchange=exchange,
                market_type=market_type,
                **identity_kwargs,
                auto_backfill=auto_backfill,
                backfill_reason=history_reason,
                backfill_requester="klines_history",
                **(
                    {"backfill_metadata": demand_metadata}
                    if demand_metadata is not None
                    else {}
                ),
            )

        def _verify_history_result(candidate: Any) -> tuple[list[dict], dict[str, Any]]:
            candidate_data = _bars_to_dicts(candidate.bars)
            candidate_verification = _verify_range_continuity(
                data=candidate_data,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                start_ms=start_ms,
                end_ms=end_ms,
                calendar=calendar,
                calendar_known=calendar_known,
                excluded_ranges=getattr(candidate, "excluded_ranges", None),
            )
            return candidate_data, candidate_verification

        # A zero-wait viewport request is the frontend's non-blocking storage probe.
        # It must report gaps but must not synchronously admit repair work that
        # then contends with the remaining 15 first-paint reads. A later
        # bounded viewport retry owns repair admission and waiting. The
        # active_hydration lane also uses zero-wait, but it must continue to
        # admit its background repair or the focused chart can never reach its
        # full history target.
        read_only_viewport_probe = max_wait_ms == 0 and intent == "viewport"
        result = await _run_history_query(
            auto_backfill=False if read_only_viewport_probe else None,
        )
        initially_empty = not bool(result.bars)
        backfill_triggered = bool(result.backfill_triggered)
        data, verification = _verify_history_result(result)
        reported_missing = [item.to_dict() for item in result.missing_ranges]
        verification_only = _verification_only_missing_ranges(
            verification["missing_ranges"],
            reported_missing,
            interval=interval,
            calendar=calendar,
        )
        if read_only_viewport_probe:
            submitted, request_ids, suppressions = False, [], []
        else:
            submitted, request_ids, suppressions = _submit_verification_repairs(
                dm,
                verification_only,
                reason=history_reason,
                requester="klines_history",
                demand_metadata=demand_metadata,
                series_identity=series_identity,
            )
        if submitted:
            result.backfill_triggered = True
            _attach_backfill_request_ids(result, request_ids)
            backfill_triggered = True
        if suppressions:
            _attach_verification_suppressions(result, suppressions)
            data, verification = _verify_history_result(result)
        await _acquire_scope_demand_for_result(
            request,
            result,
            demand_scope=request_scope,
            demand_generation=request_generation,
            demand_owner_id=demand_owner_id,
        )
        # A newer pane request can advance while the storage query is running.
        # Re-check before waiting or returning the now-stale response.
        await _reject_stale_request_generation(
            request,
            demand_scope=request_scope,
            demand_generation=request_generation,
            advance=False,
        )

        # Cold-start path: the first query of an uncached series returns no bars
        # and only schedules an *async* backfill. Without a brief wait the chart
        # paints blank and depends entirely on the client retry loop / WS event
        # to recover, which is what makes K-lines "sometimes" fail to load.
        # Poll the (fast, ~sub-second) backfill within a bounded budget so the
        # very first response already carries data. Poll re-queries pass
        # auto_backfill=False so we wait for the already-scheduled backfill
        # instead of spamming duplicate backfill requests.
        if max_wait_ms > 0 and (
            _should_wait_for_backfill(result)
            or bool(submitted and verification_only)
        ):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=max_wait_ms / 1000,
                requery=_run_history_query,
                wait_through_partial_rows=bool(result.bars or verification_only),
                coalesce_nonterminal_progress=bool(
                    _resolve_interval(
                        interval,
                        exchange=exchange,
                        market_type=market_type,
                    )["is_custom"]
                ),
                ready=lambda candidate: (
                    (
                        initially_empty
                        and _returned_history_page_ready(
                            candidate,
                            symbol=symbol,
                            interval=interval,
                            exchange=exchange,
                            market_type=market_type,
                            calendar=calendar,
                            calendar_known=calendar_known,
                        )
                    )
                    or
                    (
                        _verify_history_result(candidate)[1]["verified_contiguous"]
                        and _all_rows_final(candidate)
                    )
                    or (
                        not candidate.bars
                        and _all_rows_final(candidate)
                        and candidate.history_state == "exhausted"
                        and candidate.complete
                        and not candidate.retryable
                    )
                ),
                demand_scope=request_scope,
                demand_generation=request_generation,
                demand_owner_id=demand_owner_id,
            )
            data, verification = _verify_history_result(result)
    except asyncio.CancelledError:
        await _revoke_request_demand_owner(
            request,
            demand_owner_id,
            reason="http_query_cancelled",
        )
        raise
    except HTTPException:
        raise
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager history query failed") from exc

    # Related intervals are speculative. Admit them only after the visible
    # foreground page is fully trustworthy, and never after its HTTP consumer
    # disconnected. The scheduler still caps background work to one slot.
    if (
        bool(data)
        and bool(verification["verified_contiguous"])
        and _all_rows_final(result)
        and not identity_kwargs
        and not await _request_disconnected(request)
    ):
        _schedule_related_interval_warmup(
            dm,
            symbol=symbol,
            current_interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
            coordinator=_get_backfill_coordinator(request),
            demand_scope=request_scope,
            demand_generation=request_generation,
            demand_owner_id=demand_owner_id,
            defer_seconds=RELATED_WARMUP_DWELL_SECONDS,
        )

    missing_ranges = _merge_missing_ranges(
        [r.to_dict() for r in result.missing_ranges],
        verification["missing_ranges"],
    )
    payload = {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "intent": intent,
        "days": days,
        "count_back": count_back,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "has_tail_gap": result.has_tail_gap,
        "backfill_triggered": backfill_triggered,
        "verified_contiguous": verification["verified_contiguous"],
        "missing_ranges": missing_ranges,
        **_history_contract_payload(
            result,
            verified_contiguous=verification["verified_contiguous"],
            missing_ranges=missing_ranges,
        ),
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }
    # The 16-cell workspace can complete a warm history burst at essentially
    # the same instant. Returning a dict here makes FastAPI recursively copy
    # every one of the 500-row payloads through jsonable_encoder on the event
    # loop before JSON serialization. A response object preserves the exact
    # wire contract while avoiding that redundant traversal and its resulting
    # event-loop stall.
    return ORJSONResponse(payload)


@router.post("/history/batch")
async def post_klines_history_batch(
    request: Request,
    body: KlineHistoryBatchRequest,
):
    """Run a bounded history burst and preserve per-item outcomes.

    The single-window workspace commonly asks for 16 different series in the
    same browser task. Running those CPU-heavy storage projections in parallel
    across Python workers creates avoidable GIL contention and event-loop lag.
    Four-at-a-time execution keeps the existing endpoint semantics (including
    demand generations and backfill admission) and avoids the GIL storm created
    by 16 independent requests. The dense workspace limits its first paint to
    64 bars, so the bounded burst remains inside the hot-start gate.
    """
    seen_ids: set[str] = set()
    for item in body.requests:
        if item.request_id in seen_ids:
            raise HTTPException(
                status_code=422,
                detail=f"duplicate history batch request_id: {item.request_id}",
            )
        seen_ids.add(item.request_id)

    async def _run_item(item: KlineHistoryBatchItem) -> dict[str, Any]:
        try:
            response = await get_klines_history(
                request=request,
                symbol=item.symbol,
                interval=item.interval,
                days=item.days,
                count_back=item.count_back,
                exchange=item.exchange,
                market_type=item.market_type,
                intent=item.intent,
                request_scope=item.request_scope,
                request_generation=item.request_generation,
                max_wait_ms=item.max_wait_ms,
                series_identity_query=KlineSeriesIdentityQuery(
                    provider_id=item.provider_id,
                    venue=item.venue,
                    asset_class=item.asset_class,
                    series_variant=item.series_variant,
                    price_adjustment=item.price_adjustment,
                    session_variant=item.session_variant,
                    volume_semantics=item.volume_semantics,
                ),
            )
            payload = orjson.loads(response.body)
            return {
                "request_id": item.request_id,
                "ok": True,
                "status": response.status_code,
                "payload": payload,
            }
        except asyncio.CancelledError:
            raise
        except HTTPException as exc:
            return {
                "request_id": item.request_id,
                "ok": False,
                "status": exc.status_code,
                "detail": exc.detail,
            }
        except Exception:
            logger.exception(
                "Unexpected history batch item failure request_id=%s",
                item.request_id,
            )
            return {
                "request_id": item.request_id,
                "ok": False,
                "status": 500,
                "detail": "History batch item failed",
            }

    results: list[dict[str, Any]] = []
    for offset in range(0, len(body.requests), HISTORY_BATCH_MAX_CONCURRENCY):
        results.extend(await asyncio.gather(*(
            _run_item(item)
            for item in body.requests[
                offset:offset + HISTORY_BATCH_MAX_CONCURRENCY
            ]
        )))
    return ORJSONResponse({"results": results})


@router.get("/range")
async def get_klines_range(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1m", description="Kline interval"),
    start_ms: int = Query(..., ge=0, description="Inclusive range start in milliseconds"),
    end_ms: int = Query(..., ge=0, description="Inclusive range end in milliseconds"),
    repair: str = Query("async", description="Repair mode: none, async, or wait"),
    wait_ms: int = Query(0, ge=0, le=5000, description="Max wait time for repair=wait"),
    strict: bool = Query(True, description="Whether caller requires continuity metadata"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    request_scope: str | None = Query(
        None,
        max_length=128,
        description="Stable chart/pane scope used to supersede stale history work",
    ),
    request_generation: int | None = Query(
        None,
        ge=0,
        description="Monotonic generation within request_scope",
    ),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Get K-lines for an exact time range with continuity verification."""
    _validate_interval(interval)
    if end_ms < start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be >= start_ms")
    repair_mode = (repair or "async").strip().lower()
    if repair_mode not in {"none", "async", "wait"}:
        raise HTTPException(status_code=400, detail="repair must be one of: none, async, wait")

    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    identity_history_supported = _series_history_supported(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        identity=series_identity,
    )
    if not identity_history_supported:
        repair_mode = "none"
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    demand_owner_id = _new_request_demand_owner_id(
        request_scope,
        request_generation,
    )
    demand_metadata = _request_backfill_demand_metadata(
        demand_scope=request_scope,
        demand_generation=request_generation,
        demand_owner_id=demand_owner_id,
    )
    await _reject_stale_request_generation(
        request,
        demand_scope=request_scope,
        demand_generation=request_generation,
    )
    if identity_history_supported:
        calendar, calendar_known = _resolve_history_calendar(
            dm,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
        )
    else:
        calendar, calendar_known = None, False

    now_ms = int(time.time() * 1000)
    latest_closed_open_ms = _last_closed_open_ms(
        interval,
        now_ms,
        calendar=calendar,
    )
    effective_end_ms = min(end_ms, latest_closed_open_ms)
    reached_latest_closed_bar = end_ms >= latest_closed_open_ms
    if effective_end_ms < start_ms:
        return {
            "exchange": exchange,
            "market_type": market_type,
            **series_identity.to_dict(),
            "symbol": symbol.upper(),
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "effective_end_ms": effective_end_ms,
            "reached_latest_closed_bar": reached_latest_closed_bar,
            "query_start_ms": start_ms,
            "query_end_ms": effective_end_ms,
            "truncated": False,
            "next_end_ms": None,
            "count": 0,
            "source": "empty",
            "fetched": 0,
            "has_tail_gap": False,
            "backfill_triggered": False,
            "verified_contiguous": True,
            "renderable": True,
            "missing_ranges": [],
            "history_state": "ready",
            "complete": True,
            "retryable": False,
            "terminal_reason": None,
            "earliest_available_ms": None,
            "next_before_ms": None,
            "availability_revision": None,
            "excluded_ranges": [],
            "cache": {"strict": strict, "repair": repair_mode},
            "data": [],
            "base_interval": None,
        }

    range_cap = _cap_range_request(
        start_ms=start_ms,
        end_ms=effective_end_ms,
        interval=interval,
        calendar=calendar,
    )
    query_start_ms = range_cap["query_start_ms"]
    query_end_ms = range_cap["query_end_ms"]
    needed_limit = range_cap["needed_limit"]

    try:
        async def _run_range_query(auto_backfill: bool):
            return await run_storage(
                _call_data_manager_method,
                dm.query,
                symbol,
                interval,
                start_ms=query_start_ms,
                end_ms=query_end_ms,
                limit=needed_limit,
                exchange=exchange,
                market_type=market_type,
                **identity_kwargs,
                auto_backfill=auto_backfill,
                backfill_reason="visible_range_gap",
                backfill_requester="klines_range",
                **(
                    {"backfill_metadata": demand_metadata}
                    if demand_metadata is not None
                    else {}
                ),
            )

        def _verify_range_result(candidate: Any) -> tuple[list[dict], dict[str, Any]]:
            candidate_data = _bars_to_dicts(candidate.bars)
            candidate_verification = _verify_range_continuity(
                data=candidate_data,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                start_ms=query_start_ms,
                end_ms=query_end_ms,
                calendar=calendar,
                calendar_known=calendar_known,
                excluded_ranges=getattr(candidate, "excluded_ranges", None),
            )
            return candidate_data, candidate_verification

        result = await _run_range_query(repair_mode != "none")
        backfill_triggered = bool(result.backfill_triggered)
        data, verification = _verify_range_result(result)
        reported_missing = [item.to_dict() for item in result.missing_ranges]
        verification_only = _verification_only_missing_ranges(
            verification["missing_ranges"],
            reported_missing,
            interval=interval,
            calendar=calendar,
        )
        if repair_mode != "none":
            submitted, request_ids, suppressions = _submit_verification_repairs(
                dm,
                verification_only,
                reason="visible_range_gap",
                requester="klines_range",
                demand_metadata=demand_metadata,
                series_identity=series_identity,
            )
            if submitted:
                result.backfill_triggered = True
                _attach_backfill_request_ids(result, request_ids)
                backfill_triggered = True
            if suppressions:
                _attach_verification_suppressions(result, suppressions)
                data, verification = _verify_range_result(result)
        await _acquire_scope_demand_for_result(
            request,
            result,
            demand_scope=request_scope,
            demand_generation=request_generation,
            demand_owner_id=demand_owner_id,
        )
        await _reject_stale_request_generation(
            request,
            demand_scope=request_scope,
            demand_generation=request_generation,
            advance=False,
        )

        if (
            repair_mode == "wait"
            and wait_ms > 0
            and (
                not verification["verified_contiguous"]
                or not _all_rows_final(result)
            )
            and result.backfill_triggered
        ):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=wait_ms / 1000,
                requery=_run_range_query,
                wait_through_partial_rows=True,
                coalesce_nonterminal_progress=bool(
                    _resolve_interval(
                        interval,
                        exchange=exchange,
                        market_type=market_type,
                    )["is_custom"]
                ),
                ready=lambda candidate: (
                    _verify_range_result(candidate)[1]["verified_contiguous"]
                    and _all_rows_final(candidate)
                ),
                demand_scope=request_scope,
                demand_generation=request_generation,
                demand_owner_id=demand_owner_id,
            )
            data, verification = _verify_range_result(result)
            backfill_triggered = backfill_triggered or bool(result.backfill_triggered)
    except asyncio.CancelledError:
        await _revoke_request_demand_owner(
            request,
            demand_owner_id,
            reason="http_query_cancelled",
        )
        raise
    except HTTPException:
        raise
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager range query failed") from exc

    missing_ranges = _merge_missing_ranges(
        [r.to_dict() for r in result.missing_ranges],
        verification["missing_ranges"],
    )
    verified = verification["verified_contiguous"]
    all_rows_final = _all_rows_final(result)
    renderable = (verified and all_rows_final) or not strict
    rendered_data = data if renderable else []
    payload = {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "effective_end_ms": effective_end_ms,
        "reached_latest_closed_bar": reached_latest_closed_bar,
        "query_start_ms": query_start_ms,
        "query_end_ms": query_end_ms,
        "truncated": range_cap["truncated"],
        "next_end_ms": range_cap["next_end_ms"],
        "count": len(rendered_data),
        "source": result.source.value,
        "fetched": result.total,
        "has_tail_gap": result.has_tail_gap,
        "backfill_triggered": backfill_triggered,
        "verified_contiguous": verified,
        "all_rows_final": all_rows_final,
        "renderable": renderable,
        "missing_ranges": missing_ranges,
        "expected_bars": verification["expected_bars"],
        "actual_bars": verification["actual_bars"],
        **_history_contract_payload(
            result,
            verified_contiguous=verified,
            missing_ranges=missing_ranges,
        ),
        "cache": result.metadata,
        "data": rendered_data,
        "base_interval": None,
    }
    return ORJSONResponse(payload)


@router.get("/history/before")
async def get_klines_before(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    before: int = Query(..., description="Load data before this unix timestamp (seconds)"),
    bars: int = Query(500, ge=1, le=1000, description="How many bars to load"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    request_scope: str | None = Query(
        None,
        max_length=128,
        description="Stable chart/pane scope used to supersede stale history work",
    ),
    request_generation: int | None = Query(
        None,
        ge=0,
        description="Monotonic generation within request_scope",
    ),
    max_wait_ms: int = Query(
        4500,
        ge=0,
        le=8000,
        description=(
            "Cold-start budget (ms) to briefly wait for a load-more backfill to "
            "deliver bars before returning. Only applies when the older region is "
            "uncached and a backfill was triggered. This keeps candles in sync "
            "with the server-computed indicator stream during drag-left, which "
            "otherwise paints indicators for bars the chart has not yet received."
        ),
    ),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Paginated historical data — load bars before a timestamp."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    identity_history_supported = _series_history_supported(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        identity=series_identity,
    )
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    demand_owner_id = _new_request_demand_owner_id(
        request_scope,
        request_generation,
    )
    demand_metadata = _request_backfill_demand_metadata(
        demand_scope=request_scope,
        demand_generation=request_generation,
        demand_owner_id=demand_owner_id,
    )
    await _reject_stale_request_generation(
        request,
        demand_scope=request_scope,
        demand_generation=request_generation,
    )
    if identity_history_supported:
        calendar, calendar_known = _resolve_history_calendar(
            dm,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
        )
    else:
        calendar, calendar_known = None, False
    try:
        before_ms = before * 1000

        async def _run_before_query(auto_backfill=None):
            return await run_storage(
                _call_data_manager_method,
                dm.query_before,
                symbol, interval, before_ms, bars,
                exchange,
                market_type=market_type,
                **identity_kwargs,
                auto_backfill=auto_backfill,
                backfill_reason="visible_load_more",
                backfill_requester="klines_history_before",
                **(
                    {"backfill_metadata": demand_metadata}
                    if demand_metadata is not None
                    else {}
                ),
            )

        result = await _run_before_query()
        initially_empty = not bool(result.bars)
        backfill_triggered = bool(result.backfill_triggered)
        has_more = bool(result.has_more)
        await _acquire_scope_demand_for_result(
            request,
            result,
            demand_scope=request_scope,
            demand_generation=request_generation,
            demand_owner_id=demand_owner_id,
        )
        await _reject_stale_request_generation(
            request,
            demand_scope=request_scope,
            demand_generation=request_generation,
            advance=False,
        )

        # Cold drag-left: an uncached older region returns no bars and only
        # schedules an async backfill. Poll the (fast) backfill within a bounded
        # budget so the first response carries candles, instead of leaving a
        # multi-second window where server-streamed indicators are drawn but the
        # candle series is still empty. Poll re-queries pass auto_backfill=False
        # to avoid spamming duplicate backfill requests.
        if max_wait_ms > 0 and _should_wait_for_backfill(result):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=max_wait_ms / 1000,
                requery=_run_before_query,
                wait_through_partial_rows=bool(result.bars),
                coalesce_nonterminal_progress=bool(
                    _resolve_interval(
                        interval,
                        exchange=exchange,
                        market_type=market_type,
                    )["is_custom"]
                ),
                ready=lambda candidate: (
                    (
                        initially_empty
                        and _returned_history_page_ready(
                            candidate,
                            symbol=symbol,
                            interval=interval,
                            exchange=exchange,
                            market_type=market_type,
                            calendar=calendar,
                            calendar_known=calendar_known,
                        )
                    )
                    or _history_page_finality_ready(candidate)
                ),
                demand_scope=request_scope,
                demand_generation=request_generation,
                demand_owner_id=demand_owner_id,
            )
            # If the wait timed out before the backfill delivered bars, keep
            # has_more=True (data is still on the way) so the client retries
            # instead of concluding there is no more history. Re-queries made
            # with auto_backfill=False would otherwise report has_more=False.
            terminal = (
                getattr(result, "history_state", None) == "exhausted"
                or (
                    bool(getattr(result, "complete", False))
                    and not bool(getattr(result, "retryable", False))
                )
            )
            has_more = bool(result.has_more) if result.bars else not terminal
    except asyncio.CancelledError:
        await _revoke_request_demand_owner(
            request,
            demand_owner_id,
            reason="http_query_cancelled",
        )
        raise
    except HTTPException:
        raise
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager before query failed") from exc

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "before": before,
        "bars": bars,
        "count": len(data),
        "has_more": has_more,
        "source": result.source.value,
        "fetched": result.total,
        "backfill_triggered": backfill_triggered,
        "missing_ranges": [r.to_dict() for r in result.missing_ranges],
        **_history_contract_payload(result),
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/resolve")
async def resolve_interval_info(
    interval: str = Query(..., description="Interval to resolve, e.g. '7m' or '45m'"),
    exchange: str = Query(DEFAULT_EXCHANGE),
    market_type: str = Query(DEFAULT_MARKET_TYPE),
    purpose: IntervalPurpose = Query(IntervalPurpose.HISTORY),
):
    """Return resolution metadata for a given interval string."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    try:
        res = _resolve_interval(
            interval,
            exchange=exchange,
            market_type=market_type,
            purpose=purpose,
        )
    except IntervalResolutionError as exc:
        raise HTTPException(status_code=400, detail=exc.to_dict()) from exc
    plan = (
        {
            "use_multi_res": False,
            "base_interval": res["base_interval"],
            "factor": res["factor"],
        }
        if res["is_custom"]
        else None
    )
    return {
        "interval": interval,
        "canonical_interval": res["canonical_interval"],
        "kind": res["kind"],
        "native_interval": res["native_interval"],
        "purpose": res["purpose"],
        "is_custom": res["is_custom"],
        "custom_seconds": res["custom_seconds"],
        "base_interval": res["base_interval"],
        "factor": res["factor"],
        "fetch_plan": plan,
    }


@router.get("/storage/meta")
async def get_storage_meta(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Get storage metadata (bounds, count) for a series."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    try:
        meta = await run_storage(
            _call_data_manager_method,
            dm.get_bounds,
            symbol,
            interval,
            exchange,
            market_type=market_type,
            **identity_kwargs,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager bounds query failed: {exc}") from exc

    return {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "meta": meta,
    }


@router.get("/continuity")
async def get_klines_continuity(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1m", description="Kline interval"),
    start_ms: int | None = Query(None, ge=0, description="Inclusive scan start in milliseconds"),
    end_ms: int | None = Query(None, ge=0, description="Inclusive scan end in milliseconds"),
    limit: int = Query(50_000, ge=1, le=200_000, description="Maximum stored bars to scan"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Detect storage continuity gaps without triggering repair."""
    _validate_interval(interval)
    if start_ms is not None and end_ms is not None and end_ms < start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be >= start_ms")
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    try:
        report = await run_storage(
            dm.scan_storage_gaps,
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
            limit=limit,
            **identity_kwargs,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Continuity scan failed: {exc}") from exc

    return {
        **report,
        **series_identity.to_dict(),
        "verified_contiguous": report.get("gap_count", 0) == 0,
    }


@router.delete("/storage")
async def delete_storage_data(
    request: Request,
    symbol: str = Query(..., description="Trading symbol"),
    interval: str = Query(..., description="Kline interval"),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    series_identity_query: KlineSeriesIdentityQuery = Depends(),
):
    """Delete stored K-line data for a symbol/interval range."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    series_identity = _resolve_series_identity_query(
        exchange,
        series_identity_query,
    )
    identity_kwargs = _nonlegacy_identity_kwargs(exchange, series_identity)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    try:
        deleted = await _call_data_manager_method(
            dm.delete_storage_data,
            symbol=symbol,
            interval=interval,
            start_ms=start * 1000 if start is not None else None,
            end_ms=end * 1000 if end is not None else None,
            exchange=exchange,
            market_type=market_type,
            **identity_kwargs,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Storage delete failed: {exc}") from exc

    return {
        "exchange": exchange,
        "market_type": market_type,
        **series_identity.to_dict(),
        "symbol": symbol.upper(),
        "interval": interval,
        "deleted": deleted,
    }


def _calculate_sma_values(rows: list[dict], period: int) -> list[dict]:
    values: list[dict] = []
    closes: list[float] = []
    for row in rows:
        closes.append(float(row["close"]))
        if len(closes) < period:
            continue
        window = closes[-period:]
        values.append({
            "time": int(row["time"]),
            "value": round(sum(window) / period, 8),
        })
    return values


@router.get("/indicators/sma")
async def get_sma(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    period: int = Query(20, ge=2, le=500),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Calculate SMA indicator values from DataManager query results."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)

    try:
        if start is not None or end is not None:
            result = await run_storage(
                dm.query,
                symbol,
                interval,
                start_ms=start * 1000 if start is not None else None,
                end_ms=end * 1000 if end is not None else None,
                limit=5000,
                exchange=exchange,
                market_type=market_type,
            )
        else:
            result = await run_storage(
                dm.query_latest,
                symbol,
                interval,
                max(period * 5, 500),
                exchange,
                market_type=market_type,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SMA query failed: {exc}") from exc

    data = _calculate_sma_values(_bars_to_dicts(result.bars), period)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "period": period,
        "count": len(data),
        "data": data,
    }
