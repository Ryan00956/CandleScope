"""Plan and singleflight the official-archive lane for historical backfill."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from app.core.executors import run_storage
from app.data_engine.ingestion.metrics import LayerMetrics
from app.data_engine.interval_policy import parse_interval_ms
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.archive import (
    ArchiveCompatibilityError,
    ArchiveDataError,
    ArchiveGranularity,
    ArchiveObjectRef,
    HistoricalArchiveProvider,
)

from .archive_cache import (
    AiohttpArchiveHttpClient,
    HistoricalArchiveCache,
)
from .config import BackfillConfig
from .models import BackfillTask, FetchedBar


logger = logging.getLogger("backfill.HistoricalSourceRouter")


@dataclass(frozen=True, slots=True)
class ArchiveObjectResult:
    ref: ArchiveObjectRef
    bars: tuple[FetchedBar, ...]
    content_sha256: str
    provider_checksum: str | None
    cache_hit: bool
    revision_changed: bool
    size_bytes: int
    cache_elapsed_ms: int
    download_elapsed_ms: int
    verify_elapsed_ms: int
    parse_elapsed_ms: int

    def receipt(self) -> dict[str, Any]:
        return {
            "object_key": self.ref.object_key,
            "provider_id": self.ref.provider_id,
            "exchange": self.ref.exchange,
            "market_type": self.ref.market_type,
            "symbol": self.ref.symbol,
            "interval": self.ref.interval,
            "granularity": self.ref.granularity.value,
            "period": self.ref.period,
            "start_ms": self.ref.start_ms,
            "end_ms": self.ref.end_ms,
            "content_sha256": self.content_sha256,
            "provider_checksum": self.provider_checksum,
            "row_count": len(self.bars),
            "source_url": self.ref.url,
            "revision_changed": self.revision_changed,
            "import_version": "history-archive-import.v1",
        }


@dataclass(slots=True)
class ArchiveRoutePlan:
    refs_by_task: dict[str, tuple[ArchiveObjectRef, ...]]
    futures: dict[str, asyncio.Task[ArchiveObjectResult]]
    owner_task_by_object: dict[str, str]
    deferred_prefetch: tuple[
        tuple[HistoricalArchiveProvider, ArchiveObjectRef],
        ...,
    ] = ()
    foreground_demand: bool = True

    def refs_for(self, task: BackfillTask) -> tuple[ArchiveObjectRef, ...]:
        return self.refs_by_task.get(task.task_key, ())

    def future_for(self, ref: ArchiveObjectRef) -> asyncio.Task[ArchiveObjectResult]:
        return self.futures[ref.object_key]

    def owns_object(self, task: BackfillTask, ref: ArchiveObjectRef) -> bool:
        return self.owner_task_by_object.get(ref.object_key) == task.task_key


class HistoricalSourceRouter:
    """Select closed archive objects while leaving tails and holes to REST."""

    def __init__(
        self,
        config: BackfillConfig,
        *,
        cache: HistoricalArchiveCache | None = None,
        http: AiohttpArchiveHttpClient | Any | None = None,
        proxy_resolver=None,
        deferred_prefetch_delay_seconds: float = 15.0,
    ) -> None:
        self._cfg = config
        self._cache = cache or HistoricalArchiveCache(
            config.history_archive_cache_dir,
            max_bytes=config.history_archive_cache_max_bytes,
            revalidate_seconds=config.history_archive_revalidate_seconds,
            max_download_bytes=config.history_archive_max_download_bytes,
        )
        timeout = config.fetch_timeout if config.fetch_timeout > 0 else 60
        self._http = http or AiohttpArchiveHttpClient(
            timeout_seconds=timeout,
            proxy_resolver=proxy_resolver,
        )
        self._downloads = asyncio.Semaphore(
            max(1, int(config.history_archive_download_concurrency))
        )
        self._singleflight_lock = asyncio.Lock()
        self._inflight: dict[str, asyncio.Task[ArchiveObjectResult]] = {}
        self._background_launchers: set[asyncio.Task[None]] = set()
        self._deferred_objects: OrderedDict[
            str,
            tuple[HistoricalArchiveProvider, ArchiveObjectRef],
        ] = OrderedDict()
        self._deferred_prefetch_delay_seconds = max(
            0.0,
            float(deferred_prefetch_delay_seconds),
        )
        self._foreground_archive_ready = False
        # Filled only after BackfillEngine reports a successful reconciliation
        # pass.  This prevents the next scheduler page from carrying the same
        # 32 parent objects through parsing/import/custom aggregation again,
        # without making a failed or cancelled write disappear from retries.
        self._acknowledged_imports: OrderedDict[str, float] = OrderedDict()
        self._acknowledged_imports_max_objects = 2_048
        # A not-yet-published daily object is commonly requested again by
        # foreground chart polling while the same GapLedger range is being
        # repaired.  Remember failures briefly so every poll does not repeat
        # the same CHECKSUM/ZIP request.  This is only transport backoff: the
        # object remains eligible after the TTL and never becomes history-end
        # evidence.
        self._failed_cache: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self._failed_cache_ttl_seconds = 300
        self._failed_cache_max_objects = 256
        # One scheduler page may carry a much larger GapLedger parent range.
        # Let the first page import a bounded set of already-selected archive
        # objects in one reconciliation pass, instead of paying one complete
        # fetch/reconcile/materialize cycle per 1,000-row planner chunk.
        self._prefilled_objects: OrderedDict[str, float] = OrderedDict()
        self._parent_prefill_max_objects = 32
        # Scheduler chunks reach the fetcher through separate engine runs.
        # Keep a bounded parsed-object LRU so those runs share CSV parsing as
        # well as the on-disk ZIP.  Entries expire with checksum revalidation.
        self._parsed_cache: OrderedDict[
            str,
            tuple[float, ArchiveObjectResult],
        ] = OrderedDict()
        self._parsed_cache_bars = 0
        self._parsed_cache_max_bars = max(
            100_000,
            min(250_000, int(config.fetch_max_total_bars) * 2),
        )
        self._providers: dict[str, HistoricalArchiveProvider] = {}
        self._disabled_providers: dict[str, str] = {}
        self._metrics = LayerMetrics("HistoricalSourceRouter")

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    async def probe_enabled_capabilities(self) -> dict[str, Any]:
        """Fail closed on the explicitly enabled unstable OKX web contract."""
        if not self._cfg.history_archive_okx_enabled:
            return {"okx": {"enabled": False, "reason": "feature_flag_disabled"}}
        exchange = "okx"
        try:
            bootstrap_default_adapters()
            plugin = get_exchange_registry().get_plugin(exchange)
            factory = getattr(plugin, "history_archive_provider", None)
            provider = self._providers.get(exchange)
            if provider is None and callable(factory):
                provider = factory(self._cfg)
                if provider is not None:
                    self._providers[exchange] = provider
            if provider is None:
                raise ArchiveCompatibilityError("OKX archive provider is unavailable")
            now_ms = int(time.time() * 1_000)
            # OKX publishes a closed daily package two days later.  Probe a
            # conservative four-to-seven-day-old window and parse one real
            # object before admitting the capability to request routing.
            candidates = provider.plan_objects(
                market_type="spot",
                symbol="BTC-USDT",
                interval="1m",
                start_ms=now_ms - 7 * 86_400_000,
                end_ms=now_ms - 4 * 86_400_000,
                now_ms=now_ms,
            )
            resolved = await provider.resolve_objects(candidates, self._http)
            if not resolved:
                raise ArchiveCompatibilityError(
                    "OKX archive capability probe returned no object"
                )
            value = await self._load_object(
                provider,
                max(resolved, key=lambda item: item.start_ms),
            )
            self._metrics.inc("archive_capability_probe_success")
            return {
                "okx": {
                    "enabled": True,
                    "provider_id": provider.id,
                    "sample_rows": len(value.bars),
                },
            }
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._disable_provider(exchange, exc)
            self._metrics.inc("archive_capability_probe_failures")
            return {
                "okx": {
                    "enabled": False,
                    "reason": str(exc)[:500],
                },
            }

    async def prepare(self, tasks: list[BackfillTask]) -> ArchiveRoutePlan:
        if not self._cfg.history_archive_enabled or not tasks:
            return ArchiveRoutePlan({}, {}, {})
        bootstrap_default_adapters()
        registry = get_exchange_registry()
        refs_by_task: dict[str, list[ArchiveObjectRef]] = {}
        futures: dict[str, asyncio.Task[ArchiveObjectResult]] = {}
        owner_task_by_object: dict[str, str] = {}
        deferred_prefetch: dict[
            str,
            tuple[HistoricalArchiveProvider, ArchiveObjectRef],
        ] = {}
        scheduled_object_keys: set[str] = set()
        now_ms = int(time.time() * 1_000)
        foreground_demand = any(
            _is_foreground_archive_demand(task)
            for task in tasks
        )
        self._metrics.set(
            "last_route_requesters",
            sorted({
                str(task.metadata.get("requester") or "")
                for task in tasks
            }),
        )
        self._metrics.set(
            "last_route_reasons",
            sorted({
                str(task.metadata.get("reason") or "")
                for task in tasks
            }),
        )
        self._metrics.set(
            "last_route_foreground_demand",
            foreground_demand,
        )

        groups: dict[tuple[str, str, str, str], list[BackfillTask]] = {}
        for task in tasks:
            groups.setdefault(
                (task.exchange, task.market_type, task.symbol, task.interval),
                [],
            ).append(task)

        for (exchange, market_type, symbol, interval), group in groups.items():
            if exchange == "okx" and not self._cfg.history_archive_okx_enabled:
                continue
            if exchange in self._disabled_providers:
                continue
            try:
                plugin = registry.get_plugin(exchange)
            except KeyError:
                continue
            provider_factory = getattr(plugin, "history_archive_provider", None)
            provider = self._providers.get(exchange)
            if provider is None and callable(provider_factory):
                provider = provider_factory(self._cfg)
                if provider is not None:
                    self._providers[exchange] = provider
            if provider is None:
                continue
            capabilities = provider.capabilities(market_type)
            if not capabilities.supports(market_type=market_type, interval=interval):
                continue

            for run in _task_runs(group, interval):
                route_start_ms, route_end_ms = _archive_decision_range(run)
                candidates = provider.plan_objects(
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    start_ms=route_start_ms,
                    end_ms=route_end_ms,
                    now_ms=now_ms,
                )
                candidates = _filter_daily_candidates(
                    candidates,
                    range_start_ms=route_start_ms,
                    range_end_ms=route_end_ms,
                    interval=interval,
                    rest_page_size=capabilities.rest_page_size,
                    minimum_pages=max(1, self._cfg.history_archive_min_rest_pages),
                )
                if not candidates:
                    continue
                try:
                    resolved = await provider.resolve_objects(candidates, self._http)
                except ArchiveCompatibilityError as exc:
                    self._disable_provider(exchange, exc)
                    continue
                except Exception as exc:
                    self._metrics.inc("archive_resolver_errors")
                    self._metrics.mark("last_error_at")
                    logger.warning(
                        "rest_fallback archive resolver failed exchange=%s symbol=%s: %s",
                        exchange,
                        symbol,
                        exc,
                    )
                    continue
                actual_start_ms = min(task.start_ms for task in run)
                actual_end_ms = max(task.end_ms for task in run)
                # Resolve from the complete parent demand, but only make the
                # current foreground chunk await objects it actually touches.
                # The first touching task owns the full-object import; sibling
                # page tasks consume its coverage without duplicating writes.
                resolved_refs = _unique_refs(resolved)
                needed_refs = [
                    ref
                    for ref in resolved_refs
                    if _intersects(
                        actual_start_ms,
                        actual_end_ms,
                        ref.start_ms,
                        ref.end_ms,
                    )
                ]
                needed_keys = {ref.object_key for ref in needed_refs}
                # Order the complete parent demand with objects touching the
                # foreground chunk first.  Cold objects are launched only
                # after this fetch pass has finished its visible REST work;
                # otherwise even a separate archive semaphore competes for
                # the same physical network and regresses first paint.  Warm
                # objects can be consumed immediately, which preserves fast
                # empty-database rebuilds from the persistent ZIP cache.
                ordered_refs = [
                    *needed_refs,
                    *sorted(
                        (
                            ref
                            for ref in resolved_refs
                            if ref.object_key not in needed_keys
                            and ref.object_key not in self._acknowledged_imports
                        ),
                        key=lambda ref: _range_distance(
                            actual_start_ms,
                            actual_end_ms,
                            ref.start_ms,
                            ref.end_ms,
                        ),
                    ),
                ]
                selected_refs = ordered_refs[: self._parent_prefill_max_objects]
                newly_prefetched = await self._claim_eager_prefill(selected_refs)
                newly_prefetched_keys = {
                    ref.object_key for ref in newly_prefetched
                }
                fresh_flags = await asyncio.gather(
                    *(self._cache.has_fresh(ref) for ref in newly_prefetched)
                )
                fresh_new_keys = {
                    ref.object_key
                    for ref, is_fresh in zip(newly_prefetched, fresh_flags)
                    if is_fresh
                }
                cold_new_keys = newly_prefetched_keys - fresh_new_keys
                parent_prefill = (
                    route_start_ms < actual_start_ms
                    or route_end_ms > actual_end_ms
                )
                warm_parent_batch = (
                    parent_prefill
                    and bool(fresh_new_keys)
                )
                if warm_parent_batch:
                    # A deleted K-line database with persistent ZIPs should
                    # batch every fresh object immediately.  A single newest
                    # not-yet-published daily object may remain cold/404 and
                    # stay deferred without forcing all local objects back
                    # through one scheduler cycle each.
                    self._metrics.inc("archive_warm_parent_batches")
                parent_batch_enabled = (
                    self._foreground_archive_ready or warm_parent_batch
                )
                deferred_cold_keys = (
                    cold_new_keys
                    if parent_prefill and not self._foreground_archive_ready
                    else set()
                )
                foreground_rest_once = bool(deferred_cold_keys & needed_keys)
                newly_deferred = [
                    (provider, ref)
                    for ref in selected_refs
                    if ref.object_key in deferred_cold_keys
                ]
                pending_deferred_keys = await self._register_deferred(
                    newly_deferred
                )
                for provider_ref, archive_ref in newly_deferred:
                    deferred_prefetch.setdefault(
                        archive_ref.object_key,
                        (provider_ref, archive_ref),
                    )
                for ref in selected_refs:
                    scheduled_object_keys.add(ref.object_key)
                    if ref.object_key in pending_deferred_keys:
                        self._metrics.inc("archive_background_prefetch_objects")
                        continue
                    future = await self._singleflight(provider, ref)
                    if ref.object_key not in needed_keys:
                        if parent_batch_enabled and run:
                            # Once the protected first screen has passed, let
                            # one physical scheduler task own the bounded
                            # parent batch.  Fetcher/Reconciler already accept
                            # non-intersecting prefill receipts, so this turns
                            # dozens of download/write/materialize cycles into
                            # one range publication and lets the coordinator
                            # discard every covered page chunk at once.
                            owner = run[0]
                            futures.setdefault(ref.object_key, future)
                            owner_task_by_object.setdefault(
                                ref.object_key,
                                owner.task_key,
                            )
                            refs_by_task.setdefault(
                                owner.task_key,
                                [],
                            ).append(ref)
                            self._metrics.inc(
                                "archive_parent_batch_objects"
                            )
                        else:
                            self._metrics.inc(
                                "archive_background_prefetch_objects"
                            )
                        continue
                    futures.setdefault(ref.object_key, future)
                    touching_tasks = [
                        task
                        for task in run
                        if _intersects(
                            task.start_ms,
                            task.end_ms,
                            ref.start_ms,
                            ref.end_ms,
                        )
                    ]
                    if touching_tasks and ref.object_key not in owner_task_by_object:
                        owner_task_by_object[ref.object_key] = touching_tasks[0].task_key
                    if len(touching_tasks) > 1:
                        self._metrics.inc(
                            "archive_singleflight_waiters",
                            len(touching_tasks) - 1,
                        )
                    for task in touching_tasks:
                        refs_by_task.setdefault(task.task_key, []).append(ref)
                if foreground_rest_once:
                    self._metrics.inc("archive_foreground_rest_bypasses")

        normalized_refs = {
            task_key: tuple(_unique_refs(values))
            for task_key, values in refs_by_task.items()
        }
        self._metrics.inc("archive_route_plans")
        self._metrics.inc("archive_objects_planned", len(scheduled_object_keys))
        self._metrics.set(
            "last_archive_objects_planned",
            len(scheduled_object_keys),
        )
        return ArchiveRoutePlan(
            normalized_refs,
            futures,
            owner_task_by_object,
            tuple(deferred_prefetch.values()),
            foreground_demand,
        )

    def start_deferred_prefetch(self, route_plan: ArchiveRoutePlan) -> None:
        """Launch cold parent objects after foreground fetch work completes."""
        if not route_plan.deferred_prefetch and not self._deferred_objects:
            if route_plan.foreground_demand:
                # A warm-cache or complete-object foreground fetch has
                # already paid its archive cost.  Future left-drags must not
                # receive another synthetic "first screen" grace period.
                self._foreground_archive_ready = True
            return
        if not route_plan.foreground_demand:
            self._metrics.inc("archive_prefetch_parked_for_foreground")
            return
        if any(not task.done() for task in self._background_launchers):
            return
        launcher = asyncio.create_task(
            self._launch_deferred(),
            name="history-archive-deferred-prefetch",
        )
        self._background_launchers.add(launcher)
        launcher.add_done_callback(self._background_launchers.discard)

    def acknowledge_imports(self, object_keys: set[str]) -> None:
        """Remember objects whose complete reconciliation pass succeeded."""
        now = time.monotonic()
        for object_key in object_keys:
            normalized = str(object_key or "").strip()
            if not normalized:
                continue
            self._acknowledged_imports.pop(normalized, None)
            self._acknowledged_imports[normalized] = now
        while (
            len(self._acknowledged_imports)
            > self._acknowledged_imports_max_objects
        ):
            self._acknowledged_imports.popitem(last=False)
            self._metrics.inc("archive_import_ack_evictions")
        self._metrics.inc("archive_import_acks", len(object_keys))

    async def _launch_deferred(self) -> None:
        if self._deferred_prefetch_delay_seconds:
            await asyncio.sleep(self._deferred_prefetch_delay_seconds)
        self._foreground_archive_ready = True
        async with self._singleflight_lock:
            deferred = tuple(self._deferred_objects.values())
            self._deferred_objects.clear()
        for provider, ref in deferred:
            await self._singleflight(provider, ref)
        self._metrics.inc("archive_deferred_prefetch_batches")

    async def _register_deferred(
        self,
        values: list[tuple[HistoricalArchiveProvider, ArchiveObjectRef]],
    ) -> set[str]:
        async with self._singleflight_lock:
            for provider, ref in values:
                self._deferred_objects.setdefault(
                    ref.object_key,
                    (provider, ref),
                )
            return set(self._deferred_objects)

    def snapshot(self) -> dict[str, Any]:
        return {
            "enabled": bool(self._cfg.history_archive_enabled),
            "okx_enabled": bool(self._cfg.history_archive_okx_enabled),
            "download_concurrency": max(
                1,
                int(self._cfg.history_archive_download_concurrency),
            ),
            "minimum_rest_pages": max(
                1,
                int(self._cfg.history_archive_min_rest_pages),
            ),
            "singleflight_inflight": len(self._inflight),
            "deferred_prefetch_launchers": len(self._background_launchers),
            "deferred_prefetch_objects": len(self._deferred_objects),
            "deferred_prefetch_delay_seconds": (
                self._deferred_prefetch_delay_seconds
            ),
            "foreground_archive_ready": self._foreground_archive_ready,
            "acknowledged_import_objects": len(self._acknowledged_imports),
            "negative_cache_objects": len(self._failed_cache),
            "negative_cache_ttl_seconds": self._failed_cache_ttl_seconds,
            "prefilled_objects": len(self._prefilled_objects),
            "parent_prefill_max_objects": self._parent_prefill_max_objects,
            "parsed_cache_objects": len(self._parsed_cache),
            "parsed_cache_bars": self._parsed_cache_bars,
            "parsed_cache_max_bars": self._parsed_cache_max_bars,
            "disabled_providers": dict(self._disabled_providers),
            "cache": self._cache.snapshot(),
            "metrics": self._metrics.snapshot(),
        }

    async def _singleflight(
        self,
        provider: HistoricalArchiveProvider,
        ref: ArchiveObjectRef,
    ) -> asyncio.Task[ArchiveObjectResult]:
        async with self._singleflight_lock:
            cached = self._parsed_cache.get(ref.object_key)
            if cached is not None:
                cached_at, value = cached
                age_seconds = time.monotonic() - cached_at
                if age_seconds < max(
                    1,
                    int(self._cfg.history_archive_revalidate_seconds),
                ):
                    self._parsed_cache.move_to_end(ref.object_key)
                    self._metrics.inc("archive_parsed_cache_hits")
                    return asyncio.create_task(
                        self._return_parsed_cache_hit(value),
                        name=f"archive-parsed-cache:{ref.object_key}",
                    )
                self._parsed_cache.pop(ref.object_key, None)
                self._parsed_cache_bars = max(
                    0,
                    self._parsed_cache_bars - len(value.bars),
                )
            failed = self._failed_cache.get(ref.object_key)
            if failed is not None:
                failed_at, message = failed
                if (
                    time.monotonic() - failed_at
                    < self._failed_cache_ttl_seconds
                ):
                    self._failed_cache.move_to_end(ref.object_key)
                    self._metrics.inc("archive_negative_cache_hits")
                    return asyncio.create_task(
                        self._raise_cached_failure(message),
                        name=f"archive-negative-cache:{ref.object_key}",
                    )
                self._failed_cache.pop(ref.object_key, None)
            existing = self._inflight.get(ref.object_key)
            if existing is not None and not existing.done():
                self._metrics.inc("archive_singleflight_joins")
                return existing
            if existing is not None:
                self._remember_completed_failure(ref.object_key, existing)
                self._inflight.pop(ref.object_key, None)
                failed = self._failed_cache.get(ref.object_key)
                if failed is not None:
                    self._metrics.inc("archive_negative_cache_hits")
                    return asyncio.create_task(
                        self._raise_cached_failure(failed[1]),
                        name=f"archive-negative-cache:{ref.object_key}",
                    )
            task = asyncio.create_task(
                self._load_and_remember(provider, ref),
                name=f"archive:{ref.exchange}:{ref.symbol}:{ref.period}",
            )
            self._inflight[ref.object_key] = task
            task.add_done_callback(
                lambda completed, key=ref.object_key: asyncio.create_task(
                    self._forget(key, completed)
                )
            )
            return task

    async def _claim_eager_prefill(
        self,
        refs: list[ArchiveObjectRef],
    ) -> list[ArchiveObjectRef]:
        claimed: list[ArchiveObjectRef] = []
        async with self._singleflight_lock:
            for ref in refs:
                if ref.object_key in self._prefilled_objects:
                    self._prefilled_objects.move_to_end(ref.object_key)
                    self._metrics.inc("archive_object_prefill_joins")
                    continue
                self._prefilled_objects[ref.object_key] = time.monotonic()
                claimed.append(ref)
            while len(self._prefilled_objects) > 256:
                self._prefilled_objects.popitem(last=False)
            self._metrics.inc("archive_object_prefill_owners", len(claimed))
        return claimed

    @staticmethod
    async def _return_parsed_cache_hit(
        value: ArchiveObjectResult,
    ) -> ArchiveObjectResult:
        return replace(
            value,
            cache_hit=True,
            cache_elapsed_ms=0,
            download_elapsed_ms=0,
            verify_elapsed_ms=0,
            parse_elapsed_ms=0,
        )

    @staticmethod
    async def _raise_cached_failure(message: str) -> ArchiveObjectResult:
        raise ArchiveDataError(message)

    async def _load_and_remember(
        self,
        provider: HistoricalArchiveProvider,
        ref: ArchiveObjectRef,
    ) -> ArchiveObjectResult:
        value = await self._load_object(provider, ref)
        async with self._singleflight_lock:
            self._failed_cache.pop(ref.object_key, None)
            previous = self._parsed_cache.pop(ref.object_key, None)
            if previous is not None:
                self._parsed_cache_bars = max(
                    0,
                    self._parsed_cache_bars - len(previous[1].bars),
                )
            self._parsed_cache[ref.object_key] = (time.monotonic(), value)
            self._parsed_cache_bars += len(value.bars)
            while (
                self._parsed_cache
                and self._parsed_cache_bars > self._parsed_cache_max_bars
            ):
                evicted_key, (_, evicted) = self._parsed_cache.popitem(last=False)
                self._parsed_cache_bars = max(
                    0,
                    self._parsed_cache_bars - len(evicted.bars),
                )
                self._metrics.inc("archive_parsed_cache_evictions")
                logger.debug("Evicted parsed archive object %s", evicted_key)
            self._metrics.set(
                "archive_parsed_cache_bars",
                self._parsed_cache_bars,
            )
        return value

    async def _forget(
        self,
        key: str,
        completed: asyncio.Task[ArchiveObjectResult],
    ) -> None:
        async with self._singleflight_lock:
            self._remember_completed_failure(key, completed)
            if self._inflight.get(key) is completed:
                self._inflight.pop(key, None)

    def _remember_completed_failure(
        self,
        key: str,
        completed: asyncio.Task[ArchiveObjectResult],
    ) -> None:
        if completed.cancelled():
            return
        try:
            error = completed.exception()
        except (asyncio.CancelledError, asyncio.InvalidStateError):
            return
        if error is None:
            return
        self._failed_cache.pop(key, None)
        self._failed_cache[key] = (time.monotonic(), str(error)[:500])
        while len(self._failed_cache) > self._failed_cache_max_objects:
            self._failed_cache.popitem(last=False)
            self._metrics.inc("archive_negative_cache_evictions")

    async def _load_object(
        self,
        provider: HistoricalArchiveProvider,
        ref: ArchiveObjectRef,
    ) -> ArchiveObjectResult:
        download_started = time.monotonic()
        async with self._downloads:
            try:
                async with self._cache.materialize(ref, provider, self._http) as cached:
                    cache_elapsed_ms = int(
                        (time.monotonic() - download_started) * 1_000
                    )
                    parse_started = time.monotonic()
                    try:
                        archive_bars = await run_storage(
                            provider.parse_bars,
                            Path(cached.path),
                            ref,
                        )
                    except ArchiveCompatibilityError as exc:
                        self._disable_provider(ref.exchange, exc)
                        await self._cache.invalidate(ref.object_key)
                        raise
                    except BaseException:
                        await self._cache.invalidate(ref.object_key)
                        raise
                    parse_elapsed_ms = int((time.monotonic() - parse_started) * 1_000)
            except BaseException:
                self._metrics.inc("archive_object_errors")
                self._metrics.mark("last_error_at")
                raise

        bars = tuple(
            FetchedBar(
                symbol=ref.symbol,
                interval=ref.interval,
                open_time=bar.open_time,
                close_time=bar.close_time,
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                volume=bar.volume,
                exchange=ref.exchange,
                market_type=ref.market_type,
                quote_volume=bar.quote_volume,
                trades=bar.trades,
                taker_buy_base=bar.taker_buy_base,
                taker_buy_quote=bar.taker_buy_quote,
                source=bar.source,
                enhanced_fields=bar.enhanced_fields,
                archive_object_key=ref.object_key,
            )
            for bar in archive_bars
        )
        self._metrics.inc("archive_objects_loaded")
        self._metrics.inc("archive_rows_parsed", len(bars))
        self._metrics.inc("archive_cache_elapsed_ms_total", cache_elapsed_ms)
        self._metrics.inc("archive_parse_elapsed_ms_total", parse_elapsed_ms)
        self._metrics.set("last_cache_elapsed_ms", cache_elapsed_ms)
        self._metrics.set(
            "last_download_elapsed_ms",
            cached.download_elapsed_ms,
        )
        self._metrics.set("last_verify_elapsed_ms", cached.verify_elapsed_ms)
        self._metrics.set("last_parse_elapsed_ms", parse_elapsed_ms)
        return ArchiveObjectResult(
            ref=ref,
            bars=bars,
            content_sha256=cached.content_sha256,
            provider_checksum=cached.provider_checksum,
            cache_hit=cached.cache_hit,
            revision_changed=cached.revision_changed,
            size_bytes=cached.size_bytes,
            cache_elapsed_ms=cache_elapsed_ms,
            download_elapsed_ms=cached.download_elapsed_ms,
            verify_elapsed_ms=cached.verify_elapsed_ms,
            parse_elapsed_ms=parse_elapsed_ms,
        )

    def _disable_provider(self, exchange: str, error: BaseException) -> None:
        normalized = str(exchange or "").strip().lower()
        reason = str(error)[:500]
        self._disabled_providers[normalized] = reason
        self._metrics.inc("archive_capability_disabled")
        self._metrics.set("last_disabled_provider", normalized)
        logger.error(
            "archive capability disabled exchange=%s reason=%s",
            normalized,
            reason,
        )


def _task_runs(tasks: list[BackfillTask], interval: str) -> list[list[BackfillTask]]:
    interval_ms = parse_interval_ms(interval) or 1
    ordered = sorted(tasks, key=lambda item: (item.start_ms, item.end_ms))
    runs: list[list[BackfillTask]] = []
    for task in ordered:
        if not runs or task.start_ms > runs[-1][-1].end_ms + interval_ms:
            runs.append([task])
        else:
            runs[-1].append(task)
    return runs


def _is_foreground_archive_demand(task: BackfillTask) -> bool:
    """Keep speculative warm-start work from consuming the first-screen gate."""
    metadata = task.metadata or {}
    requester = str(metadata.get("requester") or "").strip().lower()
    reason = str(metadata.get("reason") or "").strip().lower()
    source = str(metadata.get("source") or "").strip().lower()
    if source == "background-prefetch" or reason == "background_prefetch":
        return False
    explicit = metadata.get("archive_explicit_demand")
    if explicit in {True, 1, "1", "true", "True"}:
        return True
    return (
        requester in {
            "klines_history",
            "klines_range",
            "mixed",
            "manual_history_download",
        }
        or "initial_history" in reason
        or "visible_range_gap" in reason
        or reason == "manual_history_download"
    )


def _filter_daily_candidates(
    candidates: list[ArchiveObjectRef],
    *,
    range_start_ms: int,
    range_end_ms: int,
    interval: str,
    rest_page_size: int,
    minimum_pages: int,
) -> list[ArchiveObjectRef]:
    monthly_candidates = [
        item
        for item in candidates
        if item.granularity is ArchiveGranularity.MONTHLY
    ]
    daily = [item for item in candidates if item.granularity is ArchiveGranularity.DAILY]
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0:
        return []
    monthly: list[ArchiveObjectRef] = []
    for ref in monthly_candidates:
        overlap_bars = max(
            0,
            (
                min(ref.end_ms, range_end_ms)
                - max(ref.start_ms, range_start_ms)
            ) // interval_ms + 1,
        )
        complete_requested_month = (
            range_start_ms <= ref.start_ms
            and range_end_ms >= ref.end_ms
        )
        if complete_requested_month or (
            _ceil_div(overlap_bars, rest_page_size) >= minimum_pages
        ):
            monthly.append(ref)
    if monthly:
        daily = [
            ref
            for ref in daily
            if not any(
                month.start_ms <= ref.start_ms
                and ref.end_ms <= month.end_ms
                for month in monthly
            )
        ]
    if not daily:
        return monthly
    daily_bars = sum(
        max(
            0,
            (
                min(ref.end_ms, range_end_ms)
                - max(ref.start_ms, range_start_ms)
            ) // interval_ms + 1,
        )
        for ref in daily
        if _intersects(
            range_start_ms,
            range_end_ms,
            ref.start_ms,
            ref.end_ms,
        )
    )
    if _ceil_div(daily_bars, rest_page_size) < minimum_pages:
        return monthly
    return monthly + daily


def _archive_decision_range(tasks: list[BackfillTask]) -> tuple[int, int]:
    """Recover the scheduler parent range carried by page-bounded tasks."""
    actual_start = min(task.start_ms for task in tasks)
    actual_end = max(task.end_ms for task in tasks)
    starts = [actual_start]
    ends = [actual_end]
    for task in tasks:
        raw = task.metadata.get("ledger_range")
        if not isinstance(raw, dict):
            continue
        try:
            parent_start = int(raw["start_ms"])
            parent_end = int(raw["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if parent_start <= parent_end:
            starts.append(parent_start)
            ends.append(parent_end)
    return min(starts), max(ends)


def _unique_refs(values: list[ArchiveObjectRef]) -> list[ArchiveObjectRef]:
    unique: dict[str, ArchiveObjectRef] = {}
    for item in values:
        if item.url:
            unique[item.object_key] = item
    return sorted(unique.values(), key=lambda item: (item.start_ms, item.object_key))


def _range_distance(
    left_start: int,
    left_end: int,
    right_start: int,
    right_end: int,
) -> int:
    if _intersects(left_start, left_end, right_start, right_end):
        return 0
    if right_end < left_start:
        return left_start - right_end
    return right_start - left_end


def _intersects(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start <= right_end and right_start <= left_end


def _ceil_div(value: int, divisor: int) -> int:
    return (max(0, int(value)) + max(1, int(divisor)) - 1) // max(1, int(divisor))


__all__ = [
    "ArchiveObjectResult",
    "ArchiveRoutePlan",
    "HistoricalSourceRouter",
]
