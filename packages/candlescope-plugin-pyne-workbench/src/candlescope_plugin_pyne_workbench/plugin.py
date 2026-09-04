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

_CONTRACT_LOCALIZATIONS = {
    "zh-CN": {
        "Pyne workbench contribution is not invokable": "Pyne 工作台贡献不可调用",
        "Pyne session is not active": "Pyne 会话未激活",
        "preview must be a boolean": "preview 必须是布尔值",
        "workbench completion token is stale": "工作台完成令牌已失效",
        "workbench phase is invalid": "工作台阶段无效",
        "lookbackBars must be from 2 to 5000": "lookbackBars 必须在 2 到 5000 之间",
        "paramsJson must be bounded JSON text": "paramsJson 必须是长度受限的 JSON 文本",
        "paramsJson is invalid JSON": "paramsJson 不是有效的 JSON",
        "paramsJson must contain an object": "paramsJson 必须包含对象",
        "bar fields are invalid": "K 线字段无效",
        "Host returned no market bars": "Host 未返回行情 K 线",
        "Host bars are not all final": "Host 返回的 K 线并非全部已收盘",
        "Host returned invalid bars": "Host 返回了无效 K 线",
        "capabilityUnavailable": "{permission} 能力不可用",
        "boundedString": "{key} 必须是长度受限的字符串",
    },
    "es": {
        "Pyne workbench contribution is not invokable": (
            "La contribución del banco de trabajo Pyne no se puede invocar"
        ),
        "Pyne session is not active": "La sesión de Pyne no está activa",
        "preview must be a boolean": "preview debe ser un booleano",
        "workbench completion token is stale": (
            "El token de finalización del banco de trabajo ha caducado"
        ),
        "workbench phase is invalid": "La fase del banco de trabajo no es válida",
        "lookbackBars must be from 2 to 5000": "lookbackBars debe estar entre 2 y 5000",
        "paramsJson must be bounded JSON text": (
            "paramsJson debe ser texto JSON de longitud limitada"
        ),
        "paramsJson is invalid JSON": "paramsJson no es un JSON válido",
        "paramsJson must contain an object": "paramsJson debe contener un objeto",
        "bar fields are invalid": "Los campos de la vela no son válidos",
        "Host returned no market bars": "El Host no devolvió velas de mercado",
        "Host bars are not all final": "No todas las velas del Host están cerradas",
        "Host returned invalid bars": "El Host devolvió velas no válidas",
        "capabilityUnavailable": "La capacidad {permission} no está disponible",
        "boundedString": "{key} debe ser una cadena de longitud limitada",
    },
    "fr": {
        "Pyne workbench contribution is not invokable": (
            "La contribution de l’atelier Pyne n’est pas invocable"
        ),
        "Pyne session is not active": "La session Pyne n’est pas active",
        "preview must be a boolean": "preview doit être un booléen",
        "workbench completion token is stale": "Le jeton d’achèvement de l’atelier a expiré",
        "workbench phase is invalid": "La phase de l’atelier est invalide",
        "lookbackBars must be from 2 to 5000": (
            "lookbackBars doit être compris entre 2 et 5 000"
        ),
        "paramsJson must be bounded JSON text": (
            "paramsJson doit être un texte JSON borné"
        ),
        "paramsJson is invalid JSON": "paramsJson n’est pas un JSON valide",
        "paramsJson must contain an object": "paramsJson doit contenir un objet",
        "bar fields are invalid": "Les champs de barre sont invalides",
        "Host returned no market bars": "L’hôte n’a renvoyé aucune barre de marché",
        "Host bars are not all final": "Les barres de l’hôte ne sont pas toutes finales",
        "Host returned invalid bars": "L’hôte a renvoyé des barres invalides",
        "capabilityUnavailable": "Capacité {permission} indisponible",
        "boundedString": "{key} doit être une chaîne bornée",
    },
    "ja": {
        "Pyne workbench contribution is not invokable": "Pyne ワークベンチのコントリビューションは実行できません",
        "Pyne session is not active": "Pyne セッションは有効ではありません",
        "preview must be a boolean": "preview は真偽値である必要があります",
        "workbench completion token is stale": "ワークベンチの完了トークンは無効です",
        "workbench phase is invalid": "ワークベンチの段階が不正です",
        "lookbackBars must be from 2 to 5000": "lookbackBars は 2 から 5000 である必要があります",
        "paramsJson must be bounded JSON text": "paramsJson は長さ制限のある JSON テキストである必要があります",
        "paramsJson is invalid JSON": "paramsJson は不正な JSON です",
        "paramsJson must contain an object": "paramsJson はオブジェクトである必要があります",
        "bar fields are invalid": "ローソク足フィールドが不正です",
        "Host returned no market bars": "ホストが市場のローソク足を返しませんでした",
        "Host bars are not all final": "ホストのローソク足がすべて確定していません",
        "Host returned invalid bars": "ホストが不正なローソク足を返しました",
        "capabilityUnavailable": "{permission} 能力は利用できません",
        "boundedString": "{key} は長さ制限のある文字列である必要があります",
    },
    "ko": {
        "Pyne workbench contribution is not invokable": "Pyne 작업대 기여는 호출할 수 없음",
        "Pyne session is not active": "Pyne 세션이 활성 상태가 아님",
        "preview must be a boolean": "preview는 불리언이어야 함",
        "workbench completion token is stale": "작업대 완료 토큰이 만료됨",
        "workbench phase is invalid": "작업대 단계가 유효하지 않음",
        "lookbackBars must be from 2 to 5000": "lookbackBars는 2에서 5000 사이여야 함",
        "paramsJson must be bounded JSON text": "paramsJson은 제한된 JSON 텍스트여야 함",
        "paramsJson is invalid JSON": "paramsJson이 유효한 JSON이 아님",
        "paramsJson must contain an object": "paramsJson은 객체여야 함",
        "bar fields are invalid": "캔들 필드가 유효하지 않음",
        "Host returned no market bars": "호스트가 시장 캔들을 반환하지 않음",
        "Host bars are not all final": "호스트 캔들이 모두 확정이 아님",
        "Host returned invalid bars": "호스트가 유효하지 않은 캔들을 반환함",
        "capabilityUnavailable": "{permission} 기능을 사용할 수 없음",
        "boundedString": "{key}은(는) 제한된 문자열이어야 함",
    },
    "pt-BR": {
        "Pyne workbench contribution is not invokable": (
            "A contribuição do Pyne Workbench não pode ser invocada"
        ),
        "Pyne session is not active": "A sessão Pyne não está ativa",
        "preview must be a boolean": "preview deve ser um booleano",
        "workbench completion token is stale": "O token de conclusão do workbench expirou",
        "workbench phase is invalid": "A fase do workbench é inválida",
        "lookbackBars must be from 2 to 5000": "lookbackBars deve estar entre 2 e 5000",
        "paramsJson must be bounded JSON text": (
            "paramsJson deve ser um texto JSON com tamanho limitado"
        ),
        "paramsJson is invalid JSON": "paramsJson não é um JSON válido",
        "paramsJson must contain an object": "paramsJson deve conter um objeto",
        "bar fields are invalid": "Os campos do candle são inválidos",
        "Host returned no market bars": "O Host não retornou candles de mercado",
        "Host bars are not all final": "Nem todos os candles do Host estão fechados",
        "Host returned invalid bars": "O Host retornou candles inválidos",
        "capabilityUnavailable": "A capacidade {permission} não está disponível",
        "boundedString": "{key} deve ser uma string com tamanho limitado",
    },
    "ru": {
        "Pyne workbench contribution is not invokable": "Вклад верстака Pyne нельзя вызвать",
        "Pyne session is not active": "Сессия Pyne не активна",
        "preview must be a boolean": "preview должен быть логическим значением",
        "workbench completion token is stale": "Токен завершения верстака устарел",
        "workbench phase is invalid": "Недопустимая фаза верстака",
        "lookbackBars must be from 2 to 5000": "lookbackBars должен быть от 2 до 5000",
        "paramsJson must be bounded JSON text": (
            "paramsJson должен быть ограниченным по длине текстом JSON"
        ),
        "paramsJson is invalid JSON": "paramsJson содержит недопустимый JSON",
        "paramsJson must contain an object": "paramsJson должен содержать объект",
        "bar fields are invalid": "Недопустимые поля свечи",
        "Host returned no market bars": "Host не вернул рыночные свечи",
        "Host bars are not all final": "Не все свечи Host закрыты",
        "Host returned invalid bars": "Host вернул недопустимые свечи",
        "capabilityUnavailable": "Возможность {permission} недоступна",
        "boundedString": "{key} должен быть ограниченной по длине строкой",
    },
    "zh-TW": {
        "Pyne workbench contribution is not invokable": "Pyne 工作台貢獻無法呼叫",
        "Pyne session is not active": "Pyne 工作階段尚未啟用",
        "preview must be a boolean": "preview 必須是布林值",
        "workbench completion token is stale": "工作台完成權杖已失效",
        "workbench phase is invalid": "工作台階段無效",
        "lookbackBars must be from 2 to 5000": "lookbackBars 必須介於 2 到 5000 之間",
        "paramsJson must be bounded JSON text": "paramsJson 必須是長度受限的 JSON 文字",
        "paramsJson is invalid JSON": "paramsJson 不是有效的 JSON",
        "paramsJson must contain an object": "paramsJson 必須包含物件",
        "bar fields are invalid": "K 線欄位無效",
        "Host returned no market bars": "Host 未傳回行情 K 線",
        "Host bars are not all final": "Host 傳回的 K 線並非全部已收盤",
        "Host returned invalid bars": "Host 傳回了無效 K 線",
        "capabilityUnavailable": "{permission} 功能不可用",
        "boundedString": "{key} 必須是長度受限的字串",
    },
}


def _localized_contract_error(
    error: PlatformContractError, locale: str | None
) -> PlatformContractError:
    candidate = (locale or "").strip().lower()
    messages = None
    while candidate:
        messages = next(
            (
                value
                for key, value in _CONTRACT_LOCALIZATIONS.items()
                if key.lower() == candidate
            ),
            None,
        )
        if messages is not None:
            break
        candidate = candidate.rpartition("-")[0]
    if messages is None:
        return error
    message = messages.get(error.message)
    if message is None and error.message.endswith(" capability is unavailable"):
        permission = error.message.removesuffix(" capability is unavailable")
        template = messages.get("capabilityUnavailable")
        if template is not None:
            message = template.replace("{permission}", permission)
    if message is None and error.message.endswith(" must be a bounded string"):
        key = error.message.removesuffix(" must be a bounded string")
        template = messages.get("boundedString")
        if template is not None:
            message = template.replace("{key}", key)
    if message is None:
        return error
    return PlatformContractError(error.code, message, error.path)


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
        try:
            return self._invoke(request)
        except PlatformContractError as error:
            raise _localized_contract_error(error, request.request_context.locale) from error

    def _invoke(self, request: InvokeRequest) -> InvocationOutcome:
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
        locale = state.context.locale if state is not None else None
        try:
            return self._complete_host_call(token, response)
        except PlatformContractError as error:
            raise _localized_contract_error(error, locale) from error

    def _complete_host_call(
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
