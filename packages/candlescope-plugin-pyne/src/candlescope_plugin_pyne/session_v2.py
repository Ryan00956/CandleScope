"""Additive Pyne session and brokered-data contracts beside frozen runtime v1."""
from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal

import pyne_runtime
from candlescope_plugin_sdk import (
    Bar,
    Diagnostic,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    MarketContext,
)

from .runtime import (
    _bridge_failure,
    _diagnostic_from_mapping,
    _render_output,
    _settings_for,
)


PYNE_SESSION_PROTOCOL_V2 = "candlescope.pyne-session/2"
PYNE_DATA_BROKER_PROTOCOL_V1 = "candlescope.pyne-data-broker/1"
_SESSION_ID = re.compile(r"^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$")


@dataclass(frozen=True, slots=True)
class BrokeredDataRequest:
    """Exact host-owned OHLCV range requested by Pyne."""

    request_id: str
    symbol: str
    timeframe: str
    start: int
    end: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocol": PYNE_DATA_BROKER_PROTOCOL_V1,
            "requestId": self.request_id,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "start": self.start,
            "end": self.end,
        }


@dataclass(frozen=True, slots=True)
class BrokeredDataPage:
    """Host response for one exact broker request."""

    request_id: str
    symbol: str
    timeframe: str
    start: int
    end: int
    bars: tuple[dict[str, Any], ...] = ()
    metadata: dict[str, Any] | None = None
    status: Literal["ok", "invalidSymbol"] = "ok"

    def __post_init__(self) -> None:
        if self.status not in {"ok", "invalidSymbol"}:
            raise ValueError("broker page status must be ok or invalidSymbol")
        if self.end < self.start:
            raise ValueError("broker page end must be greater than or equal to start")
        previous_time: int | None = None
        for index, bar in enumerate(self.bars):
            if not isinstance(bar, Mapping):
                raise ValueError(f"broker page bar {index} must be an object")
            missing = {"time", "open", "high", "low", "close", "volume"} - bar.keys()
            if missing:
                raise ValueError(
                    f"broker page bar {index} is missing: {', '.join(sorted(missing))}"
                )
            timestamp = bar.get("time")
            if isinstance(timestamp, bool) or not isinstance(timestamp, int):
                raise ValueError(f"broker page bar {index} time must be an integer")
            if timestamp < self.start or timestamp > self.end:
                raise ValueError(f"broker page bar {index} is outside the requested range")
            if previous_time is not None and timestamp <= previous_time:
                raise ValueError("broker page bar times must be strictly increasing")
            previous_time = timestamp

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> "BrokeredDataPage":
        if value.get("protocol") != PYNE_DATA_BROKER_PROTOCOL_V1:
            raise ValueError("broker page protocol is not supported")
        raw_bars = value.get("bars", [])
        if isinstance(raw_bars, (str, bytes)) or not isinstance(raw_bars, Sequence):
            raise ValueError("broker page bars must be an array")
        metadata = value.get("metadata")
        if metadata is not None and not isinstance(metadata, Mapping):
            raise ValueError("broker page metadata must be an object")
        return cls(
            request_id=str(value.get("requestId") or ""),
            symbol=str(value.get("symbol") or ""),
            timeframe=str(value.get("timeframe") or ""),
            start=int(value.get("start")),
            end=int(value.get("end")),
            bars=tuple(dict(item) for item in raw_bars),
            metadata=None if metadata is None else dict(metadata),
            status=str(value.get("status") or "ok"),
        )


class BrokeredDataProvider:
    """Fail-closed Pyne provider backed only by Host-supplied response pages."""

    capabilities = {
        pyne_runtime.REQUEST_SECURITY_API: True,
        pyne_runtime.REQUEST_SECURITY_LOWER_TF_API: True,
    }

    def __init__(self, pages: Sequence[BrokeredDataPage] = ()) -> None:
        self._pages = {
            (page.symbol, page.timeframe, page.start, page.end): page for page in pages
        }
        if len(self._pages) != len(pages):
            raise ValueError("broker pages must not contain duplicate coordinates")
        self.pending_requests: list[BrokeredDataRequest] = []
        self._metadata_by_context: dict[tuple[str, str], dict[str, Any]] = {}

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[pyne_runtime.OHLCVBar]:
        key = (str(symbol), str(timeframe), int(start), int(end))
        page = self._pages.get(key)
        if page is None:
            request = BrokeredDataRequest(
                request_id=_broker_request_id(*key),
                symbol=key[0],
                timeframe=key[1],
                start=key[2],
                end=key[3],
            )
            if request not in self.pending_requests:
                self.pending_requests.append(request)
            raise pyne_runtime.PyneProviderDataError("Host broker data is required")
        if page.request_id != _broker_request_id(*key):
            raise pyne_runtime.PyneProviderDataError("Host broker request correlation failed")
        if page.status == "invalidSymbol":
            raise pyne_runtime.PyneInvalidSymbolError(symbol)
        if page.metadata is not None:
            self._metadata_by_context[(key[0], key[1])] = dict(page.metadata)
        return [dict(item) for item in page.bars]

    def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
        return dict(self._metadata_by_context.get((str(symbol), str(timeframe)), {}))


@dataclass(frozen=True, slots=True)
class BrokeredExecutionResult:
    status: Literal["complete", "needsData", "failed"]
    result: ExecuteBatchResult | None = None
    data_requests: tuple[BrokeredDataRequest, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "protocol": PYNE_SESSION_PROTOCOL_V2,
            "status": self.status,
            "dataRequests": [item.to_wire() for item in self.data_requests],
        }
        if self.result is not None:
            value["result"] = self.result.to_wire()
        return value


@dataclass(frozen=True, slots=True)
class PyneV2Result:
    """Native Pyne result for v2 consumers; it is not narrowed to Render IR v1."""

    ok: bool
    output: dict[str, Any] | None = None
    inputs: tuple[dict[str, Any], ...] = ()
    meta: dict[str, Any] | None = None
    diagnostics: tuple[dict[str, Any], ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocol": PYNE_SESSION_PROTOCOL_V2,
            "ok": self.ok,
            "output": None if self.output is None else dict(self.output),
            "inputs": [dict(item) for item in self.inputs],
            "meta": dict(self.meta or {}),
            "diagnostics": [dict(item) for item in self.diagnostics],
        }


@dataclass(frozen=True, slots=True)
class BrokeredPyneV2Result:
    status: Literal["complete", "needsData", "failed"]
    result: PyneV2Result | None = None
    data_requests: tuple[BrokeredDataRequest, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "protocol": PYNE_SESSION_PROTOCOL_V2,
            "status": self.status,
            "dataRequests": [item.to_wire() for item in self.data_requests],
        }
        if self.result is not None:
            value["result"] = self.result.to_wire()
        return value


@dataclass(frozen=True, slots=True)
class _SessionSpec:
    source: str
    context: MarketContext
    params: dict[str, Any]
    options: dict[str, Any]
    retention_bars: int | None

    @property
    def fingerprint(self) -> str:
        payload = repr(
            (
                self.source,
                self.context.to_wire(),
                sorted(self.params.items()),
                sorted(self.options.items()),
                self.retention_bars,
            )
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class PyneSessionService:
    """Process-local session facade used by the v2 workbench adapter."""

    def __init__(self, *, max_sessions: int = 64, idle_ttl_seconds: float = 300.0) -> None:
        self._manager = pyne_runtime.PyneIncrementalSessionManager(
            max_sessions=max_sessions,
            idle_ttl_seconds=idle_ttl_seconds,
        )
        self._specs: dict[str, _SessionSpec] = {}
        self._active: dict[str, Any] = {}

    def open_session(
        self,
        session_id: str,
        *,
        source: str,
        context: MarketContext,
        params: Mapping[str, Any] | None = None,
        options: Mapping[str, Any] | None = None,
        retention_bars: int | None = None,
    ) -> dict[str, Any]:
        normalized_id = _session_identifier(session_id)
        self.collect_expired()
        if normalized_id in self._active:
            raise ValueError("Pyne session is already active")
        if not pyne_runtime.is_incremental_pyne_script(source):
            raise ValueError("Pyne v2 sessions require an incremental script")
        spec = _SessionSpec(
            source=str(source),
            context=context,
            params=dict(params or {}),
            options=dict(options or {}),
            retention_bars=retention_bars,
        )
        previous = self._specs.get(normalized_id)
        if previous is not None and previous.fingerprint != spec.fingerprint:
            raise ValueError("Pyne session identity is already bound to different inputs")

        def factory() -> Any:
            settings = _settings_for(context, spec.options)
            return pyne_runtime.PyneIncrementalSession(
                script=spec.source,
                params=spec.params,
                settings=settings,
                retention_bars=spec.retention_bars,
            )

        shared = self._manager.acquire(normalized_id, factory)
        self._specs[normalized_id] = spec
        self._active[normalized_id] = shared
        return {
            "protocol": PYNE_SESSION_PROTOCOL_V2,
            "sessionId": normalized_id,
            "resumed": shared.seeded,
            "scriptHash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        }

    def seed_session(
        self,
        session_id: str,
        bars: Sequence[Bar | Mapping[str, Any]],
    ) -> ExecuteBatchResult:
        shared = self._shared(session_id)
        result = self._manager.seed_or_snapshot(shared, [_bar_to_dict(item) for item in bars])
        return _incremental_execute_result(result)

    def seed_session_v2(
        self,
        session_id: str,
        bars: Sequence[Bar | Mapping[str, Any]],
    ) -> PyneV2Result:
        shared = self._shared(session_id)
        result = self._manager.seed_or_snapshot(shared, [_bar_to_dict(item) for item in bars])
        return _pyne_v2_result(result)

    def process_bar(
        self,
        session_id: str,
        bar: Bar | Mapping[str, Any],
        *,
        preview: bool,
    ) -> ExecuteBatchResult:
        shared = self._shared(session_id)
        result = self._manager.process_bar(shared, _bar_to_dict(bar), preview=preview)
        return _incremental_execute_result(result)

    def process_bar_v2(
        self,
        session_id: str,
        bar: Bar | Mapping[str, Any],
        *,
        preview: bool,
    ) -> PyneV2Result:
        shared = self._shared(session_id)
        result = self._manager.process_bar(shared, _bar_to_dict(bar), preview=preview)
        return _pyne_v2_result(result)

    def snapshot_session(self, session_id: str) -> ExecuteBatchResult:
        shared = self._shared(session_id)
        with shared.lock:
            return _incremental_execute_result(shared.session.snapshot_result())

    def snapshot_session_v2(self, session_id: str) -> PyneV2Result:
        shared = self._shared(session_id)
        with shared.lock:
            return _pyne_v2_result(shared.session.snapshot_result())

    def disconnect_session(self, session_id: str) -> None:
        normalized_id = _session_identifier(session_id)
        if self._active.pop(normalized_id, None) is not None:
            self._manager.release(normalized_id)

    def close_session(self, session_id: str) -> bool:
        normalized_id = _session_identifier(session_id)
        self.disconnect_session(normalized_id)
        removed = self._manager.close(normalized_id)
        self._specs.pop(normalized_id, None)
        return removed

    def collect_expired(self) -> tuple[str, ...]:
        expired = tuple(self._manager.collect_expired())
        for key in expired:
            self._specs.pop(key, None)
            self._active.pop(key, None)
        return expired

    def status(self) -> dict[str, Any]:
        return {
            "protocol": PYNE_SESSION_PROTOCOL_V2,
            **self._manager.snapshot(),
        }

    def _shared(self, session_id: str) -> Any:
        normalized_id = _session_identifier(session_id)
        shared = self._active.get(normalized_id)
        if shared is None:
            raise KeyError("Pyne session is not active")
        return shared


def execute_brokered_batch(
    request: ExecuteBatchRequest,
    *,
    pages: Sequence[BrokeredDataPage] = (),
) -> BrokeredExecutionResult:
    """Execute one batch or return exact Host data requests without partial success."""

    provider = BrokeredDataProvider(pages)
    try:
        settings = replace(_settings_for(request.context, request.options), data_provider=provider)
        result = pyne_runtime.execute_pyne_script(
            script=request.source,
            ohlcv=[_bar_to_dict(bar) for bar in request.bars],
            params=dict(request.params),
            settings=settings,
            executor_mode="inline",
        )
    except Exception as exc:
        failed = _bridge_failure(
            "PYNE_BRIDGE_EXECUTION_FAILED",
            "Pyne brokered execution failed unexpectedly.",
            hint=f"The runtime raised {type(exc).__name__}.",
        )
        return BrokeredExecutionResult("failed", result=failed)
    if provider.pending_requests:
        return BrokeredExecutionResult(
            "needsData",
            data_requests=tuple(provider.pending_requests),
        )
    if not bool(getattr(result, "ok", False)):
        detail = getattr(result, "error_detail", None)
        if not isinstance(detail, Mapping):
            detail = {
                "code": getattr(result, "code", None),
                "message": getattr(result, "error", None),
                "hint": getattr(result, "hint", None),
            }
        failed = ExecuteBatchResult(
            ok=False,
            diagnostics=(
                _diagnostic_from_mapping(
                    detail,
                    fallback_code="PYNE_RUNTIME_ERROR",
                    fallback_message="Pyne could not execute the brokered request.",
                ),
            ),
        )
        return BrokeredExecutionResult("failed", result=failed)
    try:
        complete = ExecuteBatchResult(
            ok=True,
            output=_render_output(result),
            inputs=tuple(getattr(result, "param_schema", None) or []),
            meta=dict(getattr(result, "meta", None) or {}),
        )
    except Exception as exc:
        failed = _bridge_failure(
            "PYNE_BRIDGE_OUTPUT_INVALID",
            "Pyne brokered output is invalid.",
            hint=str(exc),
        )
        return BrokeredExecutionResult("failed", result=failed)
    return BrokeredExecutionResult("complete", result=complete)


def execute_brokered_pyne_v2(
    request: ExecuteBatchRequest,
    *,
    pages: Sequence[BrokeredDataPage] = (),
) -> BrokeredPyneV2Result:
    """Execute with brokered data while preserving native Pyne output schema v2."""

    provider = BrokeredDataProvider(pages)
    try:
        settings = replace(_settings_for(request.context, request.options), data_provider=provider)
        result = pyne_runtime.execute_pyne_script(
            script=request.source,
            ohlcv=[_bar_to_dict(bar) for bar in request.bars],
            params=dict(request.params),
            settings=settings,
            executor_mode="inline",
        )
    except Exception as exc:
        return BrokeredPyneV2Result(
            "failed",
            result=PyneV2Result(
                ok=False,
                diagnostics=(
                    {
                        "code": "PYNE_BRIDGE_EXECUTION_FAILED",
                        "severity": "error",
                        "message": "Pyne brokered execution failed unexpectedly.",
                        "hint": f"The runtime raised {type(exc).__name__}.",
                    },
                ),
            ),
        )
    if provider.pending_requests:
        return BrokeredPyneV2Result(
            "needsData",
            data_requests=tuple(provider.pending_requests),
        )
    native = _pyne_v2_result(result)
    return BrokeredPyneV2Result("complete" if native.ok else "failed", result=native)


def _incremental_execute_result(result: Any) -> ExecuteBatchResult:
    if not bool(getattr(result, "ok", False)):
        return ExecuteBatchResult(
            ok=False,
            diagnostics=(
                Diagnostic(
                    code=str(getattr(result, "code", None) or "PYNE_RUNTIME_ERROR"),
                    severity="error",
                    message=str(getattr(result, "error", None) or "Pyne session failed."),
                    hint=getattr(result, "hint", None),
                ),
            ),
        )
    return ExecuteBatchResult(
        ok=True,
        output=_render_output(result),
        inputs=tuple(getattr(result, "param_schema", None) or []),
        meta=dict(getattr(result, "meta", None) or {}),
    )


def _pyne_v2_result(result: Any) -> PyneV2Result:
    if not bool(getattr(result, "ok", False)):
        detail = getattr(result, "error_detail", None)
        if not isinstance(detail, Mapping):
            detail = {
                "code": str(getattr(result, "code", None) or "PYNE_RUNTIME_ERROR"),
                "severity": "error",
                "message": str(getattr(result, "error", None) or "Pyne execution failed."),
                "hint": getattr(result, "hint", None),
            }
        return PyneV2Result(ok=False, diagnostics=(dict(detail),))
    raw_output = getattr(result, "output", None)
    if not isinstance(raw_output, Mapping):
        return PyneV2Result(
            ok=False,
            diagnostics=(
                {
                    "code": "PYNE_BRIDGE_OUTPUT_INVALID",
                    "severity": "error",
                    "message": "Pyne v2 output must be an object.",
                },
            ),
        )
    raw_inputs = getattr(result, "param_schema", None) or []
    return PyneV2Result(
        ok=True,
        output=dict(raw_output),
        inputs=tuple(dict(item) for item in raw_inputs if isinstance(item, Mapping)),
        meta=dict(getattr(result, "meta", None) or {}),
    )


def _broker_request_id(symbol: str, timeframe: str, start: int, end: int) -> str:
    payload = f"{symbol}\0{timeframe}\0{int(start)}\0{int(end)}"
    return "pyne-data-" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _session_identifier(value: str) -> str:
    normalized = str(value).strip()
    if not _SESSION_ID.fullmatch(normalized):
        raise ValueError("session_id must be a bounded identifier")
    return normalized


def _bar_to_dict(value: Bar | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(value, Bar):
        return {
            "time": value.time,
            "open": value.open,
            "high": value.high,
            "low": value.low,
            "close": value.close,
            "volume": value.volume,
        }
    return dict(value)
