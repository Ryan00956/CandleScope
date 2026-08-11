"""Profile-driven, multi-symbol CCXT parity matrix.

The single-symbol shadow remains useful for focused diagnosis.  This module
adds the capacity and routing gate needed before a profile can be trusted for
several concurrently active products.  Every target keeps an independent
strict comparator; the matrix verdict fails closed if any target, route, or
runtime observation fails.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    RawMessage,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.ingestion.session import SessionLayer
from app.data_engine.ingestion.transport import TransportLayer

from .models import CcxtLifecycleEvent, CcxtRawMarketEvent
from .runtime import close_ccxt_exchange
from .profile import CcxtExchangeProfile
from .profiles import (
    BinanceSpotCcxtProfile,
    BinanceUsdmCcxtProfile,
    OkxSpotCcxtProfile,
    OkxSwapCcxtProfile,
)
from .shadow import BinanceCcxtShadowComparator
from .shadow_okx import OKX_SHADOW_CHANNELS, OkxCcxtShadowComparator

MATRIX_SHADOW_SCHEMA_VERSION = "candlescope.ccxt-shadow-matrix/1"
DEFAULT_MATRIX_SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT")
_PROFILE_FACTORIES = {
    "binance_spot": BinanceSpotCcxtProfile,
    "binance_usdm": BinanceUsdmCcxtProfile,
    "okx_swap": OkxSwapCcxtProfile,
    "okx_spot": OkxSpotCcxtProfile,
}
_PROFILE_CHANNELS = {
    "binance_spot": ("kline", "aggTrade", "depth"),
    "binance_usdm": ("kline", "aggTrade", "depth"),
    "okx_swap": OKX_SHADOW_CHANNELS,
    "okx_spot": OKX_SHADOW_CHANNELS,
}
_INTERRUPTING_NATIVE_STATES = frozenset(
    {SessionHealth.RECONNECTING.value, SessionHealth.UNHEALTHY.value}
)
_INTERRUPTING_CCXT_STATES = frozenset({"error", "disconnected"})


@dataclass(frozen=True, slots=True)
class CcxtShadowTarget:
    """One independently gated market in a concurrent shadow matrix."""

    symbol: str
    ccxt_symbol: str | None = None
    interval: str = "1m"
    depth_update_interval_ms: int = 100

    def __post_init__(self) -> None:
        symbol = str(self.symbol).upper().strip()
        interval = str(self.interval).strip()
        if not symbol:
            raise ValueError("shadow target symbol must not be empty")
        if not interval:
            raise ValueError(f"shadow target {symbol} requires a K-line interval")
        if self.depth_update_interval_ms <= 0:
            raise ValueError("depth_update_interval_ms must be positive")
        object.__setattr__(self, "symbol", symbol)
        object.__setattr__(self, "interval", interval)
        if self.ccxt_symbol is not None:
            resolved = str(self.ccxt_symbol).strip()
            if not resolved:
                raise ValueError("ccxt_symbol must be non-empty when provided")
            object.__setattr__(self, "ccxt_symbol", resolved)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> CcxtShadowTarget:
        allowed = {
            "symbol",
            "ccxt_symbol",
            "interval",
            "depth_update_interval_ms",
        }
        unknown = sorted(set(value) - allowed)
        if unknown:
            raise ValueError(f"unknown shadow target fields: {', '.join(unknown)}")
        if "symbol" not in value:
            raise ValueError("shadow target requires symbol")
        return cls(
            symbol=str(value["symbol"]),
            ccxt_symbol=(
                str(value["ccxt_symbol"])
                if value.get("ccxt_symbol") is not None
                else None
            ),
            interval=str(value.get("interval", "1m")),
            depth_update_interval_ms=int(value.get("depth_update_interval_ms", 100)),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "ccxt_symbol": self.ccxt_symbol,
            "interval": self.interval,
            "depth_update_interval_ms": self.depth_update_interval_ms,
        }


def _default_targets() -> tuple[CcxtShadowTarget, ...]:
    return tuple(CcxtShadowTarget(symbol=symbol) for symbol in DEFAULT_MATRIX_SYMBOLS)


@dataclass(frozen=True, slots=True)
class CcxtShadowMatrixSpec:
    """Serializable execution contract for one shadow matrix run."""

    profile: str = "binance_usdm"
    targets: tuple[CcxtShadowTarget, ...] = field(default_factory=_default_targets)
    duration_seconds: float = 65.0
    startup_timeout_seconds: float = 45.0

    def __post_init__(self) -> None:
        profile = str(self.profile).lower().strip()
        targets = tuple(self.targets)
        if profile not in _PROFILE_FACTORIES:
            raise ValueError(
                f"unsupported shadow profile {profile!r}; "
                f"expected one of {sorted(_PROFILE_FACTORIES)}"
            )
        if not targets:
            raise ValueError("shadow matrix requires at least one target")
        symbols = [target.symbol for target in targets]
        duplicates = sorted(
            symbol for symbol, count in Counter(symbols).items() if count > 1
        )
        if duplicates:
            raise ValueError(
                "shadow matrix target symbols must be unique: " + ", ".join(duplicates)
            )
        if self.duration_seconds <= 0 or self.startup_timeout_seconds <= 0:
            raise ValueError("shadow matrix durations must be positive")
        object.__setattr__(self, "profile", profile)
        object.__setattr__(self, "targets", targets)
        object.__setattr__(self, "duration_seconds", float(self.duration_seconds))
        object.__setattr__(
            self, "startup_timeout_seconds", float(self.startup_timeout_seconds)
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> CcxtShadowMatrixSpec:
        allowed = {
            "profile",
            "targets",
            "duration_seconds",
            "startup_timeout_seconds",
        }
        unknown = sorted(set(value) - allowed)
        if unknown:
            raise ValueError(f"unknown shadow matrix fields: {', '.join(unknown)}")
        raw_targets = value.get("targets")
        targets = (
            _default_targets()
            if raw_targets is None
            else tuple(
                CcxtShadowTarget.from_mapping(target)
                for target in _require_target_list(raw_targets)
            )
        )
        return cls(
            profile=str(value.get("profile", "binance_usdm")),
            targets=targets,
            duration_seconds=float(value.get("duration_seconds", 65.0)),
            startup_timeout_seconds=float(value.get("startup_timeout_seconds", 45.0)),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "profile": self.profile,
            "targets": [target.to_wire() for target in self.targets],
            "duration_seconds": self.duration_seconds,
            "startup_timeout_seconds": self.startup_timeout_seconds,
        }


def load_shadow_matrix_spec(path: Path) -> CcxtShadowMatrixSpec:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("shadow matrix config root must be a JSON object")
    return CcxtShadowMatrixSpec.from_mapping(value)


def create_shadow_profile(name: str) -> CcxtExchangeProfile:
    normalized = str(name).lower().strip()
    try:
        factory = _PROFILE_FACTORIES[normalized]
    except KeyError as exc:
        raise ValueError(f"unsupported shadow profile: {normalized}") from exc
    return factory()


@dataclass(slots=True)
class _ShadowRoute:
    target: CcxtShadowTarget
    channel: str
    descriptor: StreamDescriptor
    ccxt_symbol: str | None = None


class CcxtShadowMatrixRunner:
    """Run one shared CCXT profile against many native streams concurrently."""

    def __init__(
        self,
        spec: CcxtShadowMatrixSpec,
        *,
        config: IngestionConfig | None = None,
        profile: CcxtExchangeProfile | None = None,
    ) -> None:
        self.spec = spec
        self.config = config or IngestionConfig()
        self.profile = profile or create_shadow_profile(spec.profile)
        self._channels = _PROFILE_CHANNELS[spec.profile]
        if spec.profile in {"okx_swap", "okx_spot"}:
            self._comparators = {
                target.symbol: OkxCcxtShadowComparator(
                    market_type=self.profile.market_type
                )
                for target in spec.targets
            }
        else:
            self._comparators = {
                target.symbol: BinanceCcxtShadowComparator(
                    market_type=self.profile.market_type
                )
                for target in spec.targets
            }
        self._routes = self._build_routes()
        self._running = False
        self._phase = "created"
        self._fatal_errors: list[dict[str, Any]] = []
        self._ccxt_errors: list[dict[str, Any]] = []
        self._native_lifecycle: list[dict[str, Any]] = []
        self._ccxt_lifecycle: list[dict[str, Any]] = []
        self._routing_violations: list[dict[str, Any]] = []
        self._ccxt_raw_events = 0
        self._routing_checks = 0
        self._max_route_matches = 0
        self._ccxt_client_count_before_close: int | None = None
        self._cleanup_state: dict[str, Any] = {}

    async def run(self) -> dict[str, Any]:
        started_at_ms = int(time.time() * 1000)
        transport = TransportLayer(self.config)
        sessions = self._native_sessions(transport)
        exchange = self.profile.create_exchange(
            self.config,
            raw_event_sink=self._on_ccxt_raw,
            lifecycle_sink=self._on_ccxt_lifecycle,
        )
        watch_tasks: list[asyncio.Task[Any]] = []
        ready = False
        self._phase = "startup"
        try:
            await transport.start()
            await asyncio.wait_for(
                exchange.load_markets(),
                timeout=self.spec.startup_timeout_seconds,
            )
            self._resolve_symbols(exchange)
            await asyncio.gather(*(session.start() for session in sessions))
            self._running = True
            watch_tasks = [
                asyncio.create_task(
                    self._watch_loop(exchange, route),
                    name=f"ccxt_shadow_{route.target.symbol}_{route.channel}",
                )
                for route in self._routes
            ]
            ready = await self._wait_until_ready()
            if ready:
                self._phase = "measurement"
                await asyncio.sleep(self.spec.duration_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - evidence belongs in the report
            self._record_fatal("run", exc)
        finally:
            self._phase = "shutdown"
            self._running = False
            clients = getattr(exchange, "clients", None)
            if isinstance(clients, dict):
                self._ccxt_client_count_before_close = len(clients)
            for task in watch_tasks:
                task.cancel()
            if watch_tasks:
                await asyncio.gather(*watch_tasks, return_exceptions=True)
            session_results = await asyncio.gather(
                *(session.stop() for session in sessions), return_exceptions=True
            )
            for result in session_results:
                if isinstance(result, BaseException):
                    self._record_fatal("native_session_stop", result)
            for operation, awaitable in (
                ("ccxt_close", close_ccxt_exchange(exchange)),
                ("transport_stop", transport.stop()),
            ):
                try:
                    await awaitable
                except Exception as exc:  # noqa: BLE001 - cleanup is a quality gate
                    self._record_fatal(operation, exc)
            session = getattr(exchange, "session", None)
            clients_after_close = getattr(exchange, "clients", None)
            self._cleanup_state = {
                "ccxt_rest_session_released": session is None
                or bool(getattr(session, "closed", False)),
                "ccxt_websocket_clients_after_close": (
                    len(clients_after_close)
                    if isinstance(clients_after_close, dict)
                    else None
                ),
                "native_transport_session_released": (
                    getattr(transport, "_http_session", None) is None
                ),
            }
            if not self._cleanup_state["ccxt_rest_session_released"]:
                self._record_fatal(
                    "cleanup_verification",
                    RuntimeError("CCXT REST session remained open after close"),
                )
            if not self._cleanup_state["native_transport_session_released"]:
                self._record_fatal(
                    "cleanup_verification",
                    RuntimeError("native transport session remained open after stop"),
                )
            self._phase = "completed"

        completed_at_ms = int(time.time() * 1000)
        return self._build_report(started_at_ms, completed_at_ms, ready)

    def _build_routes(self) -> list[_ShadowRoute]:
        routes: list[_ShadowRoute] = []
        for target in self.spec.targets:
            for channel in self._channels:
                descriptor = self._descriptor(target, channel)
                descriptor.validate()
                if not self.profile.supports(descriptor):
                    raise ValueError(
                        f"profile {self.spec.profile} does not support {descriptor.key}"
                    )
                routes.append(_ShadowRoute(target, channel, descriptor))
        return routes

    def _descriptor(self, target: CcxtShadowTarget, channel: str) -> StreamDescriptor:
        values: dict[str, Any] = {
            "symbol": target.symbol,
            "exchange": self.profile.exchange_id,
            "market_type": self.profile.market_type,
        }
        if channel == "kline":
            values.update(stream_type=StreamType.KLINE, interval=target.interval)
        elif channel == "aggTrade":
            values["stream_type"] = StreamType.AGG_TRADE
        elif channel == "depth":
            values.update(
                stream_type=StreamType.FULL_DEPTH,
                update_interval_ms=target.depth_update_interval_ms,
            )
        elif channel == "ticker":
            values["stream_type"] = StreamType.TICKER
        else:
            raise ValueError(f"unsupported shadow channel contract: {channel}")
        return StreamDescriptor(**values)

    def _resolve_symbols(self, exchange: Any) -> None:
        for route in self._routes:
            route.ccxt_symbol = route.target.ccxt_symbol or self.profile.resolve_symbol(
                exchange, route.descriptor
            )

    def _native_sessions(self, transport: TransportLayer) -> list[SessionLayer]:
        sessions: list[SessionLayer] = []
        for route in self._routes:
            session = SessionLayer(self.config, transport, route.descriptor)

            async def on_message(
                message: RawMessage, *, event_route: _ShadowRoute = route
            ) -> None:
                payload_symbol = _payload_symbol(message.payload)
                if payload_symbol != event_route.target.symbol:
                    self._record_routing_violation(
                        source="native",
                        reason="payload_symbol_mismatch",
                        channel=event_route.channel,
                        expected_symbol=event_route.target.symbol,
                        observed_symbol=payload_symbol,
                    )
                    return
                self._comparators[event_route.target.symbol].observe(
                    "native",
                    event_route.channel,
                    message.payload,
                    message.received_at_ms,
                )

            async def on_health(
                health: SessionHealth,
                reason: str,
                *,
                event_route: _ShadowRoute = route,
            ) -> None:
                self._native_lifecycle.append(
                    {
                        "symbol": event_route.target.symbol,
                        "channel": event_route.channel,
                        "state": health.value,
                        "reason": reason,
                        "phase": self._phase,
                        "observed_at_ms": int(time.time() * 1000),
                    }
                )

            session.on_message(on_message)
            session.on_health_change(on_health)
            sessions.append(session)
        return sessions

    async def _watch_loop(self, exchange: Any, route: _ShadowRoute) -> None:
        delay = 0.25
        while self._running:
            try:
                if route.ccxt_symbol is None:
                    raise RuntimeError(
                        f"unresolved CCXT symbol for {route.target.symbol}"
                    )
                await self.profile.watch(exchange, route.descriptor, route.ccxt_symbol)
                delay = 0.25
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - every provider failure is evidence
                self._ccxt_errors.append(
                    {
                        "symbol": route.target.symbol,
                        "channel": route.channel,
                        "type": type(exc).__name__,
                        "message": str(exc),
                        "phase": self._phase,
                        "observed_at_ms": int(time.time() * 1000),
                    }
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 5.0)

    async def _wait_until_ready(self) -> bool:
        deadline = asyncio.get_running_loop().time() + self.spec.startup_timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            if all(comparator.ready() for comparator in self._comparators.values()):
                return True
            await asyncio.sleep(0.05)
        return all(comparator.ready() for comparator in self._comparators.values())

    def _on_ccxt_raw(self, event: CcxtRawMarketEvent) -> None:
        matches = [
            route
            for route in self._routes
            if self.profile.matches(event, route.descriptor)
        ]
        if not matches and _ignorable_control_event(event):
            return
        self._ccxt_raw_events += 1
        self._routing_checks += len(self._routes)
        self._max_route_matches = max(self._max_route_matches, len(matches))
        if len(matches) != 1:
            self._record_routing_violation(
                source="ccxt",
                reason="unmatched_event" if not matches else "ambiguous_event",
                channel=event.channel,
                expected_symbol=None,
                observed_symbol=event.symbol,
                match_count=len(matches),
            )
            return
        route = matches[0]
        self._comparators[route.target.symbol].observe(
            "ccxt", route.channel, event.payload, event.received_at_ms
        )

    def _on_ccxt_lifecycle(self, event: CcxtLifecycleEvent) -> None:
        self._ccxt_lifecycle.append(
            {
                "state": event.state,
                "url": event.url,
                "error": event.error,
                "phase": self._phase,
                "observed_at_ms": event.observed_at_ms,
            }
        )

    def _record_routing_violation(
        self,
        *,
        source: str,
        reason: str,
        channel: str,
        expected_symbol: str | None,
        observed_symbol: str | None,
        match_count: int | None = None,
    ) -> None:
        if len(self._routing_violations) >= 100:
            return
        value: dict[str, Any] = {
            "source": source,
            "reason": reason,
            "channel": channel,
            "expected_symbol": expected_symbol,
            "observed_symbol": observed_symbol,
            "phase": self._phase,
            "observed_at_ms": int(time.time() * 1000),
        }
        if match_count is not None:
            value["match_count"] = match_count
        self._routing_violations.append(value)

    def _record_fatal(self, operation: str, exc: BaseException) -> None:
        self._fatal_errors.append(
            {
                "operation": operation,
                "type": type(exc).__name__,
                "message": str(exc),
                "phase": self._phase,
                "observed_at_ms": int(time.time() * 1000),
            }
        )

    def _build_report(
        self, started_at_ms: int, completed_at_ms: int, ready: bool
    ) -> dict[str, Any]:
        target_reports: dict[str, dict[str, Any]] = {}
        for target in self.spec.targets:
            report = self._comparators[target.symbol].report()
            gate_reasons: list[str] = []
            if not self._comparators[target.symbol].ready():
                gate_reasons.append("target_not_ready")
            if any(error["symbol"] == target.symbol for error in self._ccxt_errors):
                gate_reasons.append("ccxt_watch_error")
            if any(
                violation.get("expected_symbol") == target.symbol
                or violation.get("observed_symbol") == target.symbol
                for violation in self._routing_violations
            ):
                gate_reasons.append("routing_violation")
            if gate_reasons:
                report["overall_verdict"] = "FAIL"
            report.update(
                {
                    "gate_reasons": gate_reasons,
                    "config": {
                        **target.to_wire(),
                        "ccxt_symbol": next(
                            (
                                route.ccxt_symbol
                                for route in self._routes
                                if route.target.symbol == target.symbol
                            ),
                            target.ccxt_symbol,
                        ),
                    },
                }
            )
            target_reports[target.symbol] = report

        native_interruptions = [
            event
            for event in self._native_lifecycle
            if event["phase"] == "measurement"
            and event["state"] in _INTERRUPTING_NATIVE_STATES
        ]
        ccxt_interruptions = [
            event
            for event in self._ccxt_lifecycle
            if event["phase"] == "measurement"
            and event["state"] in _INTERRUPTING_CCXT_STATES
        ]
        matrix_reasons: list[str] = []
        verdicts = [report["overall_verdict"] for report in target_reports.values()]
        if not ready:
            matrix_reasons.append("matrix_not_ready")
        if self._fatal_errors:
            matrix_reasons.append("fatal_error")
        if self._ccxt_errors:
            matrix_reasons.append("ccxt_watch_error")
        if self._routing_violations:
            matrix_reasons.append("routing_violation")
        if native_interruptions:
            matrix_reasons.append("native_runtime_interruption")
        if ccxt_interruptions:
            matrix_reasons.append("ccxt_runtime_interruption")
        if "FAIL" in verdicts:
            matrix_reasons.append("target_failure")

        if matrix_reasons:
            overall = "FAIL"
        elif verdicts and all(verdict == "PASS" for verdict in verdicts):
            overall = "PASS"
        else:
            overall = "INCONCLUSIVE"
            matrix_reasons.append("target_inconclusive")

        return {
            "schema_version": MATRIX_SHADOW_SCHEMA_VERSION,
            "overall_verdict": overall,
            "reasons": list(dict.fromkeys(matrix_reasons)),
            "started_at_ms": started_at_ms,
            "completed_at_ms": completed_at_ms,
            "elapsed_seconds": round((completed_at_ms - started_at_ms) / 1000, 3),
            "ready": ready,
            "config": self.spec.to_wire(),
            "profile": {
                "exchange": self.profile.exchange_id,
                "market_type": self.profile.market_type,
            },
            "summary": _matrix_summary(target_reports, self._channels),
            "targets": target_reports,
            "routing": {
                "strategy": "profile.matches scan over every active route",
                "route_count": len(self._routes),
                "ccxt_raw_events": self._ccxt_raw_events,
                "routing_checks": self._routing_checks,
                "max_route_matches": self._max_route_matches,
                "violations": self._routing_violations,
            },
            "capacity": {
                "target_count": len(self.spec.targets),
                "stream_count": len(self._routes),
                "native_session_count": len(self._routes),
                "ccxt_watch_task_count": len(self._routes),
                "ccxt_websocket_client_count_before_close": (
                    self._ccxt_client_count_before_close
                ),
            },
            "runtime": {
                "observation_window": (
                    "INTERRUPTED"
                    if self._ccxt_errors or native_interruptions or ccxt_interruptions
                    else "STABLE"
                ),
                "native_lifecycle": self._native_lifecycle,
                "ccxt_lifecycle": self._ccxt_lifecycle,
                "native_interruptions": native_interruptions,
                "ccxt_interruptions": ccxt_interruptions,
                "ccxt_errors": self._ccxt_errors,
                "fatal_errors": self._fatal_errors,
                "cleanup": self._cleanup_state,
            },
        }


def _matrix_summary(
    target_reports: Mapping[str, Mapping[str, Any]], channels: Sequence[str]
) -> dict[str, Any]:
    target_verdicts = Counter(
        str(report["overall_verdict"]) for report in target_reports.values()
    )
    channel_totals: dict[str, dict[str, int]] = {}
    for channel in channels:
        totals = {
            "pass": 0,
            "fail": 0,
            "inconclusive": 0,
            "shared_records": 0,
            "payload_matches": 0,
            "payload_mismatches": 0,
            "native_only_in_overlap": 0,
            "ccxt_only_in_overlap": 0,
            "native_continuity_violations": 0,
            "ccxt_continuity_violations": 0,
        }
        for report in target_reports.values():
            channel_report = report["channels"][channel]
            verdict = str(channel_report["verdict"]).lower()
            totals[verdict] += 1
            comparison = channel_report["strict_comparison"]
            for key in (
                "shared_records",
                "payload_matches",
                "payload_mismatches",
                "native_only_in_overlap",
                "ccxt_only_in_overlap",
            ):
                totals[key] += int(comparison[key])
            totals["native_continuity_violations"] += int(
                channel_report["sources"]["native"]["continuity_violations"]
            )
            totals["ccxt_continuity_violations"] += int(
                channel_report["sources"]["ccxt"]["continuity_violations"]
            )
        channel_totals[channel] = totals
    return {
        "target_verdicts": {
            "pass": target_verdicts["PASS"],
            "fail": target_verdicts["FAIL"],
            "inconclusive": target_verdicts["INCONCLUSIVE"],
        },
        "channels": channel_totals,
    }


def _require_target_list(value: Any) -> Sequence[Mapping[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("shadow matrix targets must be a JSON array")
    if not all(isinstance(target, dict) for target in value):
        raise ValueError("every shadow matrix target must be a JSON object")
    return value


def _payload_symbol(payload: Mapping[str, Any]) -> str | None:
    kline = payload.get("k")
    arg = payload.get("arg")
    value = payload.get("s")
    if value in (None, "") and isinstance(kline, Mapping):
        value = kline.get("s")
    if value in (None, "") and isinstance(arg, Mapping):
        value = arg.get("instId")
    if value in (None, ""):
        return None
    return str(value).upper().strip()


def _ignorable_control_event(event: CcxtRawMarketEvent) -> bool:
    control = str(event.payload.get("event") or "").lower()
    if control in {"subscribe", "unsubscribe", "login"}:
        return True
    return event.symbol is None and event.channel == "message"
