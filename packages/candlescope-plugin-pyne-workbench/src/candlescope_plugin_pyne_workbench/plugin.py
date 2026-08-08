"""Independent Plugin Platform v2 sidecar for developing and running Pyne scripts."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from importlib.resources import files
from typing import Any

import pyne_runtime
from candlescope_plugin_pyne import (
    BrokeredDataPage,
    PyneSessionService,
    PyneV2Result,
    execute_brokered_pyne_v2,
)
from candlescope_plugin_sdk import Bar, ExecuteBatchRequest, MarketContext as RuntimeMarketContext
from candlescope_plugin_sdk.platform_v2 import (
    ActivationRequest,
    ChartContextSnapshot,
    ChartLayerPublishRequest,
    HostCallRequest,
    InvokeRequest,
    PluginManifest,
    RequestContext,
    RpcFailure,
    RpcSuccess,
    RuntimeDescriptor,
    descriptor_from_manifest,
)
from candlescope_plugin_sdk.platform_v2.errors import PlatformContractError
from candlescope_plugin_sdk.platform_v2.json_codec import loads_strict
from candlescope_plugin_sdk.platform_v2.runtime import (
    BasePlatformPlugin,
    HostCallInvocation,
    InvocationOutcome,
)
from candlescope_plugin_sdk.platform_v2.server import serve_platform_plugin

from .render_adapter import AdaptedRender, adapt_pyne_output


WORKBENCH_PROTOCOL_V1 = "candlescope.pyne-workbench/1"
_LAYER_ID = "pyne-output"


def pyne_workbench_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


@dataclass(slots=True)
class _SessionBinding:
    chart: ChartContextSnapshot
    bar_times: list[int]


@dataclass(slots=True)
class _InvocationState:
    operation: str
    context: RequestContext
    input: dict[str, Any]
    phase: str = "chart"
    chart: ChartContextSnapshot | None = None
    bars: tuple[Bar, ...] = ()
    pages: list[BrokeredDataPage] = field(default_factory=list)
    active_request: Any = None
    adapted: AdaptedRender | None = None
    native: PyneV2Result | None = None


class PyneWorkbenchPlugin(BasePlatformPlugin):
    """Command-driven Pyne lab using only scoped Host calls and native output v2."""

    def __init__(self) -> None:
        self._manifest = pyne_workbench_manifest()
        self._capabilities: dict[str, str] = {}
        self._pending: dict[str, _InvocationState] = {}
        self._sessions: dict[str, _SessionBinding] = {}
        self._session_service = PyneSessionService(max_sessions=16, idle_ttl_seconds=900)
        self._layer_revision = 0

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        self._capabilities = {item.permission_id: item.handle for item in request.capabilities}
        self._pending.clear()
        self._layer_revision = 0

    def deactivate(self, reason: str) -> None:
        _ = reason
        self._pending.clear()
        for session_id in list(self._sessions):
            self._session_service.close_session(session_id)
        self._sessions.clear()
        self._capabilities.clear()

    def shutdown(self) -> None:
        self.deactivate("shutdown")

    def cancel(self, token: str) -> None:
        self._pending.pop(token, None)

    def health_check(self) -> dict[str, Any]:
        return {
            "status": "ready",
            "protocol": WORKBENCH_PROTOCOL_V1,
            "pending": len(self._pending),
            "sessions": len(self._sessions),
            "pyneOutputSchema": pyne_runtime.PYNE_OUTPUT_SCHEMA_VERSION,
        }

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        operation = request.contribution_id
        if operation == "close-session":
            session_id = _required_string(request.input, "sessionId", maximum=128)
            closed = self._session_service.close_session(session_id)
            self._sessions.pop(session_id, None)
            return {
                "protocol": WORKBENCH_PROTOCOL_V1,
                "operation": operation,
                "sessionId": session_id,
                "closed": closed,
            }
        if operation in {"push-bar", "snapshot-session"}:
            return self._invoke_existing_session(request)
        if operation not in {"run", "start-session"}:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "Pyne workbench contribution is not invokable",
                f"invoke.{operation}",
            )
        _required_string(request.input, "source", maximum=16_384)
        if operation == "start-session":
            _required_string(request.input, "sessionId", maximum=128)
        _lookback(request.input)
        _params(request.input)
        token = "pyne-" + uuid.uuid4().hex
        state = _InvocationState(operation, request.request_context, dict(request.input))
        self._pending[token] = state
        return self._host_call(
            token,
            state,
            permission_id="chart.context.read",
            method="chart.context.read",
            params={"chartId": "main-chart"},
            phase="chart",
        )

    def _invoke_existing_session(self, request: InvokeRequest) -> InvocationOutcome:
        session_id = _required_string(request.input, "sessionId", maximum=128)
        binding = self._sessions.get(session_id)
        if binding is None:
            raise PlatformContractError("INVALID_CONTRACT", "Pyne session is not active")
        if request.contribution_id == "push-bar":
            bar = _input_bar(request.input)
            preview = request.input.get("preview", False)
            if not isinstance(preview, bool):
                raise PlatformContractError("INVALID_CONTRACT", "preview must be a boolean")
            step = self._session_service.process_bar_v2(
                session_id,
                bar,
                preview=preview,
            )
            if not step.ok:
                return _native_failure(request.contribution_id, step)
            native = self._session_service.snapshot_session_v2(session_id)
            if not preview and (not binding.bar_times or binding.bar_times[-1] != bar.time):
                binding.bar_times.append(bar.time)
        else:
            native = self._session_service.snapshot_session_v2(session_id)
        return self._finish_native_session(
            request.contribution_id,
            session_id,
            request.request_context,
            binding,
            native,
        )

    def _finish_native_session(
        self,
        operation: str,
        session_id: str,
        request_context: RequestContext,
        binding: _SessionBinding,
        native: PyneV2Result,
    ) -> InvocationOutcome:
        if not native.ok or native.output is None:
            return _native_failure(operation, native)
        adapted = adapt_pyne_output(native.output, bar_times=binding.bar_times)
        if not adapted.render["items"]:
            return _summary(operation, native, adapted, layer_published=False, session_id=session_id)
        token = "pyne-" + uuid.uuid4().hex
        state = _InvocationState(
            operation,
            request_context,
            {"sessionId": session_id},
            chart=binding.chart,
            adapted=adapted,
            native=native,
        )
        self._pending[token] = state
        return self._publish(token, state)

    def complete_host_call(
        self,
        token: str,
        response: RpcSuccess | RpcFailure,
    ) -> InvocationOutcome:
        state = self._pending.get(token)
        if state is None:
            raise PlatformContractError("INVALID_CONTRACT", "workbench completion token is stale")
        if isinstance(response, RpcFailure):
            self._pending.pop(token, None)
            return {
                "protocol": WORKBENCH_PROTOCOL_V1,
                "operation": state.operation,
                "completed": False,
                "phase": state.phase,
                "error": response.error.code,
            }
        if state.phase == "chart":
            chart = ChartContextSnapshot.from_wire(response.result)
            if not chart.active or chart.context is None or chart.series is None:
                self._pending.pop(token, None)
                return {
                    "protocol": WORKBENCH_PROTOCOL_V1,
                    "operation": state.operation,
                    "completed": False,
                    "error": "NO_ACTIVE_CHART",
                }
            state.chart = chart
            return self._host_call(
                token,
                state,
                permission_id="market.bars.read",
                method="market.bars.read",
                params={
                    "context": chart.context.to_wire(),
                    "series": chart.series.to_wire(),
                    "limit": _lookback(state.input),
                },
                phase="primary-bars",
            )
        if state.phase == "primary-bars":
            state.bars = _host_bars(response.result, require_final=True)
            if state.operation == "start-session":
                return self._start_session(token, state)
            return self._continue_batch(token, state)
        if state.phase == "broker-bars":
            request = state.active_request
            rows = _host_bars(response.result, require_final=False)
            state.pages.append(
                BrokeredDataPage(
                    request_id=request.request_id,
                    symbol=request.symbol,
                    timeframe=request.timeframe,
                    start=request.start,
                    end=request.end,
                    bars=tuple(_bar_dict(item) for item in rows),
                )
            )
            state.active_request = None
            return self._continue_batch(token, state)
        if state.phase == "publish":
            self._pending.pop(token, None)
            assert state.native is not None and state.adapted is not None
            session_id = state.input.get("sessionId")
            result = _summary(
                state.operation,
                state.native,
                state.adapted,
                layer_published=True,
                session_id=session_id if isinstance(session_id, str) else None,
            )
            result["layerReceipt"] = response.result
            return result
        raise PlatformContractError("INVALID_CONTRACT", "workbench phase is invalid")

    def _start_session(self, token: str, state: _InvocationState) -> InvocationOutcome:
        assert state.chart is not None and state.chart.context is not None
        assert state.chart.series is not None
        session_id = _required_string(state.input, "sessionId", maximum=128)
        context = _runtime_context(state.chart)
        try:
            opened = self._session_service.open_session(
                session_id,
                source=_required_string(state.input, "source", maximum=16_384),
                context=context,
                params=_params(state.input),
                retention_bars=state.input.get("retentionBars"),
            )
            native = self._session_service.seed_session_v2(session_id, state.bars)
        except Exception:
            self._session_service.close_session(session_id)
            raise
        binding = _SessionBinding(state.chart, [bar.time for bar in state.bars])
        self._sessions[session_id] = binding
        state.input["sessionId"] = session_id
        state.native = native
        if not native.ok or native.output is None:
            self._pending.pop(token, None)
            self._session_service.close_session(session_id)
            self._sessions.pop(session_id, None)
            return _native_failure(state.operation, native)
        state.adapted = adapt_pyne_output(native.output, bar_times=binding.bar_times)
        if not state.adapted.render["items"]:
            self._pending.pop(token, None)
            result = _summary(
                state.operation,
                native,
                state.adapted,
                layer_published=False,
                session_id=session_id,
            )
            result["session"] = opened
            return result
        return self._publish(token, state)

    def _continue_batch(self, token: str, state: _InvocationState) -> InvocationOutcome:
        assert state.chart is not None
        request = ExecuteBatchRequest(
            source=_required_string(state.input, "source", maximum=16_384),
            context=_runtime_context(state.chart),
            bars=state.bars,
            params=_params(state.input),
        )
        outcome = execute_brokered_pyne_v2(request, pages=state.pages)
        if outcome.status == "needsData":
            known = {page.request_id for page in state.pages}
            missing = next((item for item in outcome.data_requests if item.request_id not in known), None)
            if missing is None:
                self._pending.pop(token, None)
                return {
                    "protocol": WORKBENCH_PROTOCOL_V1,
                    "operation": state.operation,
                    "completed": False,
                    "error": "BROKER_NO_PROGRESS",
                }
            assert state.chart.context is not None
            state.active_request = missing
            return self._host_call(
                token,
                state,
                permission_id="market.bars.read",
                method="market.bars.read",
                params={
                    "context": state.chart.context.to_wire(),
                    "series": {"symbol": missing.symbol, "interval": missing.timeframe},
                    "startMs": missing.start * 1000,
                    "endMs": missing.end * 1000,
                    "limit": 5_000,
                },
                phase="broker-bars",
            )
        if outcome.result is None or not outcome.result.ok or outcome.result.output is None:
            self._pending.pop(token, None)
            return _native_failure(state.operation, outcome.result or PyneV2Result(False))
        state.native = outcome.result
        state.adapted = adapt_pyne_output(
            outcome.result.output,
            bar_times=[bar.time for bar in state.bars],
        )
        if not state.adapted.render["items"]:
            self._pending.pop(token, None)
            return _summary(
                state.operation,
                state.native,
                state.adapted,
                layer_published=False,
            )
        return self._publish(token, state)

    def _publish(self, token: str, state: _InvocationState) -> HostCallInvocation:
        assert state.chart is not None and state.chart.context is not None
        assert state.chart.series is not None and state.adapted is not None
        self._layer_revision += 1
        publish = ChartLayerPublishRequest(
            layer_id=_LAYER_ID,
            chart_id=state.chart.chart_id,
            chart_revision=state.chart.revision,
            context=state.chart.context,
            series=state.chart.series,
            revision=self._layer_revision,
            render=state.adapted.render,
        )
        return self._host_call(
            token,
            state,
            permission_id="chart.layer.publish",
            method="chart.layer.publish",
            params=publish.to_wire(),
            phase="publish",
        )

    def _host_call(
        self,
        token: str,
        state: _InvocationState,
        *,
        permission_id: str,
        method: str,
        params: dict[str, Any],
        phase: str,
    ) -> HostCallInvocation:
        handle = self._capabilities.get(permission_id)
        if handle is None:
            raise PlatformContractError(
                "INVALID_CONTRACT", f"{permission_id} capability is unavailable"
            )
        state.phase = phase
        return HostCallInvocation(
            token=token,
            call=HostCallRequest(
                capability_handle=handle,
                method=method,
                params=params,
                request_context=state.context,
            ),
        )


def _runtime_context(chart: ChartContextSnapshot) -> RuntimeMarketContext:
    assert chart.context is not None and chart.series is not None
    return RuntimeMarketContext(
        exchange=chart.context.exchange,
        market_type=chart.context.market_type,
        symbol=chart.series.symbol,
        interval=chart.series.interval,
    )


def _required_string(value: dict[str, Any], key: str, *, maximum: int) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item.strip() or len(item) > maximum:
        raise PlatformContractError("INVALID_CONTRACT", f"{key} must be a bounded string")
    return item


def _lookback(value: dict[str, Any]) -> int:
    item = value.get("lookbackBars", 500)
    if isinstance(item, bool) or not isinstance(item, int) or not 2 <= item <= 5_000:
        raise PlatformContractError("INVALID_CONTRACT", "lookbackBars must be from 2 to 5000")
    return item


def _params(value: dict[str, Any]) -> dict[str, Any]:
    raw = value.get("paramsJson", "{}")
    if not isinstance(raw, str) or len(raw) > 16_384:
        raise PlatformContractError("INVALID_CONTRACT", "paramsJson must be bounded JSON text")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PlatformContractError("INVALID_CONTRACT", "paramsJson is invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise PlatformContractError("INVALID_CONTRACT", "paramsJson must contain an object")
    return parsed


def _input_bar(value: dict[str, Any]) -> Bar:
    try:
        return Bar(
            time=value.get("time"),
            open=value.get("open"),
            high=value.get("high"),
            low=value.get("low"),
            close=value.get("close"),
            volume=value.get("volume"),
            is_closed=not bool(value.get("preview", False)),
        )
    except Exception as exc:
        raise PlatformContractError("INVALID_CONTRACT", "bar fields are invalid") from exc


def _host_bars(result: dict[str, Any], *, require_final: bool) -> tuple[Bar, ...]:
    rows = result.get("data")
    if not isinstance(rows, list) or not rows:
        raise PlatformContractError("INVALID_CONTRACT", "Host returned no market bars")
    if require_final and result.get("coverage", {}).get("allRowsFinal") is not True:
        raise PlatformContractError("INVALID_CONTRACT", "Host bars are not all final")
    try:
        return tuple(
            Bar(
                time=row["time"],
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=row["close"],
                volume=row["volume"],
                is_closed=bool(row.get("is_closed", row.get("isClosed", True))),
            )
            for row in rows
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise PlatformContractError("INVALID_CONTRACT", "Host returned invalid bars") from exc


def _bar_dict(bar: Bar) -> dict[str, Any]:
    return {
        "time": bar.time,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
    }


def _native_failure(operation: str, native: PyneV2Result) -> dict[str, Any]:
    return {
        "protocol": WORKBENCH_PROTOCOL_V1,
        "operation": operation,
        "completed": False,
        "diagnostics": [dict(item) for item in native.diagnostics],
    }


def _summary(
    operation: str,
    native: PyneV2Result,
    adapted: AdaptedRender,
    *,
    layer_published: bool,
    session_id: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "protocol": WORKBENCH_PROTOCOL_V1,
        "operation": operation,
        "completed": True,
        "pyneOutputSchema": pyne_runtime.PYNE_OUTPUT_SCHEMA_VERSION,
        "sourceCounts": dict(adapted.source_counts),
        "renderItems": len(adapted.render["items"]),
        "renderDiagnostics": list(adapted.diagnostics),
        "runtimeMeta": dict(native.meta or {}),
        "layerPublished": layer_published,
    }
    if session_id is not None:
        result["sessionId"] = session_id
    return result


def main() -> int:
    return serve_platform_plugin(PyneWorkbenchPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
