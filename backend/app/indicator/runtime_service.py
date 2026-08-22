"""Generic legacy/shadow/sidecar execution for Indicator script runtimes."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from candlescope_plugin_sdk import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    Bar,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    MarketContext,
    RuntimeDescriptor,
)

from app.plugin_runtime.errors import PluginHostError

from .runtime_routes import (
    ROUTE_MODE_LEGACY,
    ROUTE_MODE_SHADOW,
    ROUTE_MODE_SIDECAR,
    IndicatorRuntimeRoute,
    IndicatorRuntimeRoutes,
    IndicatorRuntimeRoutesError,
    load_indicator_runtime_routes_from_environment,
)


MAX_RECENT_ROUTE_RESULTS = 64
DEFAULT_MAX_PENDING_SHADOW_TASKS = 64
INDICATOR_RUNTIME_CATALOG_SCHEMA_VERSION = 1

logger = logging.getLogger(__name__)


class RuntimeHost(Protocol):
    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor: ...

    async def execute_batch(
        self,
        runtime_id: str,
        request: ExecuteBatchRequest,
    ) -> ExecuteBatchResult: ...


@dataclass(frozen=True, slots=True)
class IndicatorRuntimeRequest:
    """Host-owned script execution request shared by every public transport."""

    language: str
    source: str
    exchange: str
    market_type: str
    symbol: str
    interval: str
    bars: tuple[Any, ...]
    params: dict[str, Any] = field(default_factory=dict)
    options: dict[str, Any] = field(default_factory=dict)
    transport: str = "indicator"

    def __post_init__(self) -> None:
        if not isinstance(self.source, str):
            raise TypeError("source must be a string")
        for name in (
            "language",
            "exchange",
            "market_type",
            "symbol",
            "interval",
            "transport",
        ):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")
        object.__setattr__(self, "bars", tuple(self.bars))
        object.__setattr__(self, "params", dict(self.params))
        object.__setattr__(self, "options", dict(self.options))

    def to_sdk_request(self) -> ExecuteBatchRequest:
        return ExecuteBatchRequest(
            source=self.source,
            context=MarketContext(
                exchange=self.exchange,
                market_type=self.market_type,
                symbol=self.symbol,
                interval=self.interval,
            ),
            bars=tuple(_to_sdk_bar(item) for item in self.bars),
            params=dict(self.params),
            options=dict(self.options),
        )


@dataclass(frozen=True, slots=True)
class IndicatorRuntimeFailure:
    """Sanitized transport failure plus an internal symbolic cause."""

    runtime_id: str
    cause_code: str
    public_code: str = "INDICATOR_RUNTIME_UNAVAILABLE"

    @classmethod
    def from_exception(
        cls,
        runtime_id: str,
        exc: BaseException,
    ) -> "IndicatorRuntimeFailure":
        cause_code = (
            exc.code if isinstance(exc, PluginHostError) else type(exc).__name__
        )
        return cls(runtime_id=runtime_id, cause_code=str(cause_code))


class IndicatorRuntimeUnavailableError(Exception):
    """A sidecar-only transport cannot execute and must not cache a result."""

    def __init__(self, failure: IndicatorRuntimeFailure) -> None:
        self.failure = failure
        super().__init__(f"Script runtime {failure.runtime_id!r} is unavailable.")


async def removed_in_process_runtime() -> dict[str, Any]:
    """Fail closed if a stale legacy/shadow route reaches a deleted adapter."""
    raise IndicatorRuntimeRoutesError(
        "the in-process script runtime adapter has been removed; install and route "
        "an isolated sidecar plugin instead"
    )


LegacyExecutor = Callable[[], Awaitable[dict[str, Any]]]
SidecarAdapter = Callable[[ExecuteBatchResult], dict[str, Any]]
FailureAdapter = Callable[[IndicatorRuntimeFailure], dict[str, Any]]
CatalogProjector = Callable[[Mapping[str, Any]], dict[str, Any]]


def _value(item: Any, *names: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        for name in names:
            if name in item:
                return item[name]
        return default
    for name in names:
        if hasattr(item, name):
            return getattr(item, name)
    return default


def _to_sdk_bar(item: Any) -> Bar:
    return Bar(
        time=int(_value(item, "time")),
        open=float(_value(item, "open")),
        high=float(_value(item, "high")),
        low=float(_value(item, "low")),
        close=float(_value(item, "close")),
        volume=float(_value(item, "volume")),
        is_closed=bool(_value(item, "is_closed", "isClosed", default=True)),
    )


def _default_failure_payload(
    failure: IndicatorRuntimeFailure,
) -> dict[str, Any]:
    # Imported lazily to keep the routing core independent from public payload
    # construction while still providing a safe default for callers.
    from .serialization import build_error_payload

    return build_error_payload(
        failure.public_code,
        f"Script runtime {failure.runtime_id!r} is unavailable.",
        hint="请检查插件是否已激活并通过健康检查；sidecar 模式不会静默回退到 legacy。",
    )


def _canonical_payload(payload: Mapping[str, Any]) -> tuple[str, str]:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return encoded.decode("utf-8"), f"sha256:{hashlib.sha256(encoded).hexdigest()}"


class IndicatorRuntimeService:
    """Select one script runtime without coupling transports to plugin code.

    ``legacy`` executes only the in-process implementation. ``shadow`` starts
    legacy and sidecar work together, returns the legacy payload byte-for-byte,
    and records a bounded comparison. ``sidecar`` returns only the plugin
    payload and never falls back implicitly.
    """

    def __init__(
        self,
        routes: IndicatorRuntimeRoutes,
        *,
        host: RuntimeHost | None = None,
        legacy_languages: frozenset[str] = frozenset({"pyne"}),
        max_pending_shadow_tasks: int = DEFAULT_MAX_PENDING_SHADOW_TASKS,
    ) -> None:
        if max_pending_shadow_tasks < 1:
            raise ValueError("max_pending_shadow_tasks must be positive")
        self.routes = routes
        self.host = host
        self.legacy_languages = legacy_languages
        self.max_pending_shadow_tasks = int(max_pending_shadow_tasks)
        self._start_lock = asyncio.Lock()
        self._started = False
        self._runtime_descriptors: dict[str, RuntimeDescriptor] = {}
        self._route_failures: dict[str, IndicatorRuntimeFailure] = {}
        self._catalog_projector: CatalogProjector | None = None
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._pending_shadow = 0
        self._lock = threading.Lock()
        self._counts = {
            "legacy": 0,
            "shadow": 0,
            "sidecar": 0,
            "shadowMatched": 0,
            "shadowMismatched": 0,
            "shadowSkipped": 0,
            "sidecarErrors": 0,
        }
        self._recent: list[dict[str, Any]] = []

    @classmethod
    def legacy_only(cls) -> "IndicatorRuntimeService":
        service = cls(IndicatorRuntimeRoutes.legacy_default())
        service._started = True
        return service

    async def start(self) -> None:
        if self._started:
            return
        async with self._start_lock:
            if self._started:
                return
            descriptors: dict[str, RuntimeDescriptor] = {}
            failures: dict[str, IndicatorRuntimeFailure] = {}
            for route in self.routes.routes:
                if (
                    route.mode in {ROUTE_MODE_LEGACY, ROUTE_MODE_SHADOW}
                    and route.language not in self.legacy_languages
                ):
                    raise IndicatorRuntimeRoutesError(
                        f"language {route.language!r} has no legacy adapter and "
                        f"must use sidecar mode"
                    )
                if route.mode == ROUTE_MODE_LEGACY:
                    continue
                runtime_id = route.runtime_id or ""
                if self.host is None or route.runtime_id is None:
                    failures[route.language] = IndicatorRuntimeFailure(
                        runtime_id,
                        "PLUGIN_HOST_UNAVAILABLE",
                    )
                    continue
                try:
                    descriptor = descriptors.get(route.runtime_id)
                    if descriptor is None:
                        descriptor = await self.host.descriptor(route.runtime_id)
                    language_ids = {item.id for item in descriptor.languages}
                    if route.language not in language_ids:
                        failures[route.language] = IndicatorRuntimeFailure(
                            route.runtime_id,
                            "INDICATOR_RUNTIME_LANGUAGE_UNDECLARED",
                        )
                        continue
                    missing_features = sorted(
                        {
                            FEATURE_BATCH_EXECUTION_V1,
                            FEATURE_RENDER_LINE_SERIES_V1,
                        }
                        - set(descriptor.features)
                    )
                    if missing_features:
                        failures[route.language] = IndicatorRuntimeFailure(
                            route.runtime_id,
                            "INDICATOR_RUNTIME_FEATURES_MISSING",
                        )
                        continue
                    descriptors[route.runtime_id] = descriptor
                except PluginHostError as exc:
                    failures[route.language] = IndicatorRuntimeFailure.from_exception(
                        route.runtime_id,
                        exc,
                    )
                except Exception as exc:
                    failures[route.language] = IndicatorRuntimeFailure.from_exception(
                        route.runtime_id,
                        exc,
                    )
            self._runtime_descriptors = descriptors
            self._route_failures = failures
            self._started = True

    async def stop(self) -> None:
        tasks = tuple(self._background_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._background_tasks.clear()

    async def drain_shadow(self) -> None:
        """Wait for current shadow comparisons; intended for gates and tests."""
        tasks = tuple(self._background_tasks)
        if tasks:
            await asyncio.gather(*tasks)

    def bind_catalog_projector(self, projector: CatalogProjector) -> None:
        """Bind the Phase 13 unified-catalog projection exactly once."""

        if not callable(projector):
            raise TypeError("catalog projector must be callable")
        if self._catalog_projector is not None and self._catalog_projector != projector:
            raise IndicatorRuntimeRoutesError(
                "script runtime catalog projector is already bound"
            )
        self._catalog_projector = projector

    def compatibility_source_catalog(self) -> dict[str, Any]:
        """Return the validated native v1 projection for the compatibility bridge.

        The runtime descriptor is already the plugin's public handshake contract.
        This projection adds only host-owned routing state; it never includes
        registry paths, commands, process identifiers, stderr, or failure details.
        """
        if not self._started:
            raise IndicatorRuntimeRoutesError(
                "script runtime catalog was requested before startup validation"
            )
        runtimes: dict[str, dict[str, Any]] = {}
        languages: list[dict[str, Any]] = []

        for route in self.routes.routes:
            if route.mode == ROUTE_MODE_LEGACY:
                languages.append(
                    {
                        "id": route.language,
                        "name": route.language,
                        "extensions": [],
                        "aliases": [],
                        "runtimeId": None,
                        "routeMode": route.mode,
                        "available": route.language in self.legacy_languages,
                        "features": [],
                    }
                )
                continue

            descriptor = (
                self._runtime_descriptors.get(route.runtime_id)
                if route.runtime_id is not None
                else None
            )
            language = next(
                (
                    item
                    for item in (descriptor.languages if descriptor is not None else ())
                    if item.id == route.language
                ),
                None,
            )
            if (
                self._route_failures.get(route.language) is not None
                or self.host is None
                or route.runtime_id is None
                or descriptor is None
                or language is None
            ):
                languages.append(
                    {
                        "id": route.language,
                        "name": route.language,
                        "extensions": [],
                        "aliases": [],
                        "runtimeId": route.runtime_id,
                        "routeMode": route.mode,
                        "available": False,
                        "features": [],
                    }
                )
                continue
            runtimes.setdefault(descriptor.id, descriptor.to_wire())
            languages.append(
                {
                    **language.to_wire(),
                    "runtimeId": descriptor.id,
                    "routeMode": route.mode,
                    "available": True,
                    "features": list(descriptor.features),
                }
            )

        return {
            "schemaVersion": INDICATOR_RUNTIME_CATALOG_SCHEMA_VERSION,
            "defaultLanguage": "pyne",
            "languages": languages,
            "runtimes": list(runtimes.values()),
        }

    async def public_catalog(self) -> dict[str, Any]:
        """Project routed script languages through the unified Phase 13 catalog."""

        await self.start()
        source = self.compatibility_source_catalog()
        if self._catalog_projector is None:
            return source
        return self._catalog_projector(source)

    def route_for(self, language: str) -> IndicatorRuntimeRoute:
        return self.routes.for_language(language)

    def uses_legacy(self, language: str) -> bool:
        return self.route_for(language).mode in {
            ROUTE_MODE_LEGACY,
            ROUTE_MODE_SHADOW,
        }

    async def execute(
        self,
        request: IndicatorRuntimeRequest,
        *,
        legacy: LegacyExecutor,
        adapt_sidecar: SidecarAdapter,
        adapt_failure: FailureAdapter = _default_failure_payload,
    ) -> dict[str, Any]:
        await self.start()
        route = self.route_for(request.language)
        self._increment(route.mode)

        if route.mode == ROUTE_MODE_LEGACY:
            return await legacy()

        assert route.runtime_id is not None
        if route.mode == ROUTE_MODE_SIDECAR:
            return await self._sidecar_or_failure(
                route,
                request,
                adapt_sidecar=adapt_sidecar,
                adapt_failure=adapt_failure,
                record_failure=True,
            )

        if not self._reserve_shadow():
            legacy_payload = await legacy()
            self._increment("shadowSkipped")
            self._append_recent(
                {
                    "at": int(time.time()),
                    "language": request.language,
                    "runtimeId": route.runtime_id,
                    "transport": request.transport,
                    "mode": route.mode,
                    "status": "skipped_capacity",
                }
            )
            return legacy_payload

        legacy_task = asyncio.create_task(
            legacy(),
            name=f"indicator-legacy:{request.language}:{request.transport}",
        )
        legacy_payload_ready: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        sidecar_task = asyncio.create_task(
            self._sidecar_or_failure(
                route,
                request,
                adapt_sidecar=adapt_sidecar,
                adapt_failure=adapt_failure,
                record_failure=False,
            ),
            name=(f"indicator-shadow:{route.runtime_id}:{request.transport}"),
        )
        self._background_tasks.add(sidecar_task)
        sidecar_task.add_done_callback(self._background_tasks.discard)
        finalizer = asyncio.create_task(
            self._finish_shadow(
                sidecar_task,
                legacy_payload_ready=legacy_payload_ready,
                route=route,
                request=request,
            ),
            name=(f"indicator-shadow-compare:{route.runtime_id}:{request.transport}"),
        )
        self._background_tasks.add(finalizer)
        finalizer.add_done_callback(
            lambda task: self._on_shadow_finalizer_done(task, sidecar_task)
        )
        try:
            legacy_payload = await legacy_task
        except BaseException:
            legacy_payload_ready.cancel()
            finalizer.cancel()
            sidecar_task.cancel()
            await asyncio.gather(
                finalizer,
                sidecar_task,
                return_exceptions=True,
            )
            raise
        # Callers may add transport-owned top-level fields after execute()
        # returns. Compare the adapter boundary, not those later decorations.
        legacy_payload_ready.set_result(dict(legacy_payload))
        return legacy_payload

    async def _finish_shadow(
        self,
        sidecar_task: asyncio.Task[dict[str, Any]],
        *,
        legacy_payload_ready: asyncio.Future[dict[str, Any]],
        route: IndicatorRuntimeRoute,
        request: IndicatorRuntimeRequest,
    ) -> None:
        assert route.runtime_id is not None
        legacy_payload = await asyncio.shield(legacy_payload_ready)
        try:
            sidecar_payload = await sidecar_task
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # Defensive: adapters are host extensions too.
            failure = IndicatorRuntimeFailure.from_exception(
                route.runtime_id,
                exc,
            )
            self._record_shadow_failure(route, request, failure)
            return

        if sidecar_payload.get("ok") is False and sidecar_payload.get("code") == (
            "INDICATOR_RUNTIME_UNAVAILABLE"
        ):
            cause = str(
                sidecar_payload.get("_runtimeCause") or "INDICATOR_RUNTIME_UNAVAILABLE"
            )
            self._record_shadow_failure(
                route,
                request,
                IndicatorRuntimeFailure(route.runtime_id, cause),
            )
            return

        self._record_shadow_comparison(
            route,
            request,
            legacy_payload,
            sidecar_payload,
        )

    def _on_shadow_finalizer_done(
        self,
        task: asyncio.Task[None],
        sidecar_task: asyncio.Task[dict[str, Any]],
    ) -> None:
        self._background_tasks.discard(task)
        if not sidecar_task.done():
            sidecar_task.cancel()
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                logger.warning(
                    "Indicator shadow finalizer failed (%s)",
                    type(error).__name__,
                )
        self._release_shadow()

    async def _sidecar_or_failure(
        self,
        route: IndicatorRuntimeRoute,
        request: IndicatorRuntimeRequest,
        *,
        adapt_sidecar: SidecarAdapter,
        adapt_failure: FailureAdapter,
        record_failure: bool,
    ) -> dict[str, Any]:
        assert route.runtime_id is not None
        startup_failure = self._route_failures.get(route.language)
        if startup_failure is not None:
            if record_failure:
                self._increment("sidecarErrors")
                self._append_recent(
                    {
                        "at": int(time.time()),
                        "language": request.language,
                        "runtimeId": route.runtime_id,
                        "transport": request.transport,
                        "mode": route.mode,
                        "status": "sidecar_error",
                        "causeCode": startup_failure.cause_code,
                    }
                )
            if route.mode == ROUTE_MODE_SHADOW:
                return {
                    "ok": False,
                    "code": "INDICATOR_RUNTIME_UNAVAILABLE",
                    "_runtimeCause": startup_failure.cause_code,
                }
            payload = adapt_failure(startup_failure)
            if not isinstance(payload, dict):
                raise TypeError("failure adapter must return a dict payload")
            return payload
        try:
            if self.host is None:
                raise IndicatorRuntimeRoutesError("plugin host is unavailable")
            result = await self.host.execute_batch(
                route.runtime_id,
                request.to_sdk_request(),
            )
            payload = adapt_sidecar(result)
            if not isinstance(payload, dict):
                raise TypeError("sidecar adapter must return a dict payload")
            return payload
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = IndicatorRuntimeFailure.from_exception(route.runtime_id, exc)
            if record_failure:
                self._increment("sidecarErrors")
                self._append_recent(
                    {
                        "at": int(time.time()),
                        "language": request.language,
                        "runtimeId": route.runtime_id,
                        "transport": request.transport,
                        "mode": route.mode,
                        "status": "sidecar_error",
                        "causeCode": failure.cause_code,
                    }
                )
            if route.mode == ROUTE_MODE_SHADOW:
                return {
                    "ok": False,
                    "code": "INDICATOR_RUNTIME_UNAVAILABLE",
                    "_runtimeCause": failure.cause_code,
                }
            payload = adapt_failure(failure)
            if not isinstance(payload, dict):
                raise TypeError("failure adapter must return a dict payload")
            return payload

    def _record_shadow_comparison(
        self,
        route: IndicatorRuntimeRoute,
        request: IndicatorRuntimeRequest,
        legacy_payload: dict[str, Any],
        sidecar_payload: dict[str, Any],
    ) -> None:
        try:
            legacy_canonical, legacy_hash = _canonical_payload(legacy_payload)
            sidecar_canonical, sidecar_hash = _canonical_payload(sidecar_payload)
            matched = legacy_canonical == sidecar_canonical
            fields = sorted(
                key
                for key in set(legacy_payload) | set(sidecar_payload)
                if legacy_payload.get(key) != sidecar_payload.get(key)
            )
            status = "matched" if matched else "mismatched"
        except (TypeError, ValueError) as exc:
            matched = False
            legacy_hash = None
            sidecar_hash = None
            fields = []
            status = "comparison_error"
            comparison_error = type(exc).__name__
        self._increment("shadowMatched" if matched else "shadowMismatched")
        self._append_recent(
            {
                "at": int(time.time()),
                "language": request.language,
                "runtimeId": route.runtime_id,
                "transport": request.transport,
                "mode": route.mode,
                "status": status,
                "legacySha256": legacy_hash,
                "sidecarSha256": sidecar_hash,
                "differingFields": fields,
                **(
                    {"comparisonError": comparison_error}
                    if status == "comparison_error"
                    else {}
                ),
            }
        )

    def _record_shadow_failure(
        self,
        route: IndicatorRuntimeRoute,
        request: IndicatorRuntimeRequest,
        failure: IndicatorRuntimeFailure,
    ) -> None:
        self._increment("sidecarErrors")
        self._append_recent(
            {
                "at": int(time.time()),
                "language": request.language,
                "runtimeId": route.runtime_id,
                "transport": request.transport,
                "mode": route.mode,
                "status": "sidecar_error",
                "causeCode": failure.cause_code,
            }
        )

    def _increment(self, key: str) -> None:
        with self._lock:
            self._counts[key] = self._counts.get(key, 0) + 1

    def _reserve_shadow(self) -> bool:
        with self._lock:
            if self._pending_shadow >= self.max_pending_shadow_tasks:
                return False
            self._pending_shadow += 1
            return True

    def _release_shadow(self) -> None:
        with self._lock:
            self._pending_shadow = max(0, self._pending_shadow - 1)

    def _append_recent(self, item: dict[str, Any]) -> None:
        with self._lock:
            self._recent.append(item)
            if len(self._recent) > MAX_RECENT_ROUTE_RESULTS:
                del self._recent[: len(self._recent) - MAX_RECENT_ROUTE_RESULTS]

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            counts = dict(self._counts)
            recent = [dict(item) for item in self._recent]
            pending_shadow = self._pending_shadow
        return {
            "schemaVersion": 1,
            "started": self._started,
            "source": (
                "configured-file"
                if self.routes.source is not None
                else "built-in-default"
            ),
            "routes": [route.to_wire() for route in self.routes.routes],
            "unavailable": [
                {
                    "language": language,
                    "runtimeId": failure.runtime_id,
                    "causeCode": failure.cause_code,
                }
                for language, failure in self._route_failures.items()
            ],
            "counts": counts,
            "pendingShadow": pending_shadow,
            "maxPendingShadow": self.max_pending_shadow_tasks,
            "recent": recent,
        }


def build_indicator_runtime_service_from_environment(
    *,
    host: RuntimeHost | None,
    environ: Mapping[str, str] | None = None,
) -> IndicatorRuntimeService:
    return IndicatorRuntimeService(
        load_indicator_runtime_routes_from_environment(environ),
        host=host,
        legacy_languages=frozenset(),
    )


def build_unbound_indicator_runtime_service() -> IndicatorRuntimeService:
    """Return a fail-closed fallback for direct calls outside app startup."""
    return IndicatorRuntimeService(
        IndicatorRuntimeRoutes.pyne_sidecar_default(),
        host=None,
        legacy_languages=frozenset(),
    )


__all__ = [
    "IndicatorRuntimeFailure",
    "IndicatorRuntimeRequest",
    "IndicatorRuntimeService",
    "IndicatorRuntimeUnavailableError",
    "INDICATOR_RUNTIME_CATALOG_SCHEMA_VERSION",
    "build_unbound_indicator_runtime_service",
    "build_indicator_runtime_service_from_environment",
    "removed_in_process_runtime",
]
