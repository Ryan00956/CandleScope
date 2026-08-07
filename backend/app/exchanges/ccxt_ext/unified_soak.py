"""Real-network acceptance and soak runner for generic CCXT unified streams."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    RawMessage,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)

from .catalog import get_ccxt_catalog_entry
from .generic import CcxtUnifiedProfile
from .runtime import CcxtRuntimePool
from .session import CcxtProviderSession
from .unified import CcxtUnifiedNormalizer

logger = logging.getLogger("ccxt.unified_soak")
UNIFIED_SOAK_SCHEMA_VERSION = "candlescope.ccxt.unified_soak/1"
_SEEN_TRADE_LIMIT = 50_000


@dataclass(slots=True)
class UnifiedStreamAudit:
    descriptor: StreamDescriptor
    events: int = 0
    parse_failures: int = 0
    validation_failures: int = 0
    duplicates: int = 0
    regressions: int = 0
    timestamp_regressions: int = 0
    max_timestamp_regression_ms: int = 0
    first_event_at_ms: int | None = None
    last_event_at_ms: int | None = None
    last_exchange_time_ms: int | None = None
    last_sequence: int | None = None
    last_kline_open_ms: int | None = None
    samples: list[dict[str, Any]] = field(default_factory=list)
    _seen_trades: OrderedDict[str, None] = field(
        default_factory=OrderedDict,
        repr=False,
    )

    def observe_raw(self, message: RawMessage, normalizer: CcxtUnifiedNormalizer) -> None:
        event = normalizer.parse(message)
        if event is None:
            self.parse_failures += 1
            self._sample("parse_failure", {"payload": message.payload})
            return
        self.observe_event(event)

    def observe_event(self, event: MarketEvent) -> None:
        now_ms = int(time.time() * 1000)
        self.events += 1
        self.first_event_at_ms = self.first_event_at_ms or now_ms
        self.last_event_at_ms = now_ms
        if (
            event.source != DataSource.PLUGIN
            or event.exchange != self.descriptor.exchange
            or event.symbol != self.descriptor.symbol
            or event.market_type != self.descriptor.market_type
            or event.event_type != self.descriptor.stream_type
        ):
            self._invalid(
                "identity",
                {
                    "source": event.source.value,
                    "exchange": event.exchange,
                    "symbol": event.symbol,
                    "market_type": event.market_type,
                    "event_type": event.event_type.value,
                },
            )
            return
        if (
            self.last_exchange_time_ms is not None
            and event.event_time_ms < self.last_exchange_time_ms
        ):
            regression_ms = self.last_exchange_time_ms - event.event_time_ms
            self.timestamp_regressions += 1
            self.max_timestamp_regression_ms = max(
                self.max_timestamp_regression_ms,
                regression_ms,
            )
            self._sample(
                "event_time_regression",
                {
                    "previous": self.last_exchange_time_ms,
                    "current": event.event_time_ms,
                    "regression_ms": regression_ms,
                },
            )
        self.last_exchange_time_ms = max(
            event.event_time_ms,
            self.last_exchange_time_ms or event.event_time_ms,
        )
        validators = {
            StreamType.KLINE: self._observe_kline,
            StreamType.TRADE: self._observe_trade,
            StreamType.DEPTH: self._observe_depth,
            StreamType.TICKER: self._observe_ticker,
        }
        validators[event.event_type](event)

    def _observe_kline(self, event: MarketEvent) -> None:
        data = event.data
        open_time = _integer(data.get("open_time"))
        values = [_number(data.get(key)) for key in ("open", "high", "low", "close")]
        volume = _number(data.get("volume"))
        if open_time is None or any(value is None for value in values) or volume is None:
            self._invalid("kline_fields", data)
            return
        open_price, high, low, close = values
        assert open_price is not None and high is not None and low is not None and close is not None
        if (
            open_price <= 0
            or high < max(open_price, close)
            or low > min(open_price, close)
            or low <= 0
            or volume < 0
        ):
            self._invalid("kline_values", data)
        if self.last_kline_open_ms is not None and open_time < self.last_kline_open_ms:
            self.regressions += 1
            self._sample(
                "kline_open_regression",
                {"previous": self.last_kline_open_ms, "current": open_time},
            )
        self.last_kline_open_ms = max(
            open_time,
            self.last_kline_open_ms or open_time,
        )

    def _observe_trade(self, event: MarketEvent) -> None:
        data = event.data
        trade_id = str(data.get("trade_id") or "")
        price = _number(data.get("price"))
        quantity = _number(data.get("quantity"))
        if not trade_id or price is None or price <= 0 or quantity is None or quantity <= 0:
            self._invalid("trade_values", data)
            return
        if trade_id in self._seen_trades:
            self.duplicates += 1
            self._sample("duplicate_trade", {"trade_id": trade_id})
            return
        self._seen_trades[trade_id] = None
        while len(self._seen_trades) > _SEEN_TRADE_LIMIT:
            self._seen_trades.popitem(last=False)

    def _observe_depth(self, event: MarketEvent) -> None:
        data = event.data
        bids = data.get("bids")
        asks = data.get("asks")
        sequence = _integer(event.sequence)
        limit = self.descriptor.depth_levels or 0
        if (
            not isinstance(bids, list)
            or not isinstance(asks, list)
            or not bids
            or not asks
            or len(bids) > limit
            or len(asks) > limit
            or sequence is None
        ):
            self._invalid("depth_shape", data)
            return
        best_bid = _level_price(bids[0])
        best_ask = _level_price(asks[0])
        if best_bid is None or best_ask is None or best_bid >= best_ask:
            self._invalid("depth_crossed", data)
        if self.last_sequence is not None and sequence <= self.last_sequence:
            self.regressions += 1
            self._sample(
                "depth_revision_regression",
                {"previous": self.last_sequence, "current": sequence},
            )
        self.last_sequence = sequence

    def _observe_ticker(self, event: MarketEvent) -> None:
        price = _number(event.data.get("last_price"))
        if price is None or price <= 0:
            self._invalid("ticker_price", event.data)

    def _invalid(self, reason: str, data: Any) -> None:
        self.validation_failures += 1
        self._sample(reason, data)

    def _sample(self, reason: str, data: Any) -> None:
        if len(self.samples) < 20:
            self.samples.append({"reason": reason, "data": data})

    def to_dict(self) -> dict[str, Any]:
        return {
            "events": self.events,
            "parse_failures": self.parse_failures,
            "validation_failures": self.validation_failures,
            "duplicates": self.duplicates,
            "regressions": self.regressions,
            "timestamp_regressions": self.timestamp_regressions,
            "max_timestamp_regression_ms": self.max_timestamp_regression_ms,
            "first_event_at_ms": self.first_event_at_ms,
            "last_event_at_ms": self.last_event_at_ms,
            "last_exchange_time_ms": self.last_exchange_time_ms,
            "last_sequence": self.last_sequence,
            "last_kline_open_ms": self.last_kline_open_ms,
            "samples": list(self.samples),
            "descriptor": {
                "key": self.descriptor.key,
                "exchange": self.descriptor.exchange,
                "market_type": self.descriptor.market_type,
                "symbol": self.descriptor.symbol,
                "stream_type": self.descriptor.stream_type.value,
                "interval": self.descriptor.interval,
                "depth_levels": self.descriptor.depth_levels,
            },
        }


@dataclass(slots=True)
class UnifiedHealthAudit:
    transitions: int = 0
    states: dict[str, int] = field(default_factory=dict)
    last_state: str = SessionHealth.DISCONNECTED.value
    last_reason: str = ""
    samples: list[dict[str, Any]] = field(default_factory=list)

    def observe(self, state: SessionHealth, reason: str) -> None:
        self.transitions += 1
        self.states[state.value] = self.states.get(state.value, 0) + 1
        self.last_state = state.value
        self.last_reason = reason
        if len(self.samples) < 20:
            self.samples.append(
                {
                    "state": state.value,
                    "reason": reason,
                    "observed_at_ms": int(time.time() * 1000),
                }
            )


class CcxtUnifiedSoakRunner:
    """Exercise generic unified streams through one shared real CCXT runtime."""

    def __init__(
        self,
        *,
        exchange_id: str = "bybit",
        market_type: str = "swap.linear",
        symbols: tuple[str, ...] = ("BTC/USDT:USDT", "ETH/USDT:USDT"),
        interval: str = "1m",
        depth_levels: int = 5,
        duration_seconds: float = 14_400.0,
        startup_timeout_seconds: float = 60.0,
        heartbeat_seconds: float = 30.0,
        stale_after_seconds: float = 90.0,
        disconnect_at_seconds: tuple[float, ...] = (),
        progress_path: Path | None = None,
    ) -> None:
        if duration_seconds <= 0 or startup_timeout_seconds <= 0:
            raise ValueError("duration and startup timeout must be positive")
        if heartbeat_seconds <= 0 or stale_after_seconds <= 0:
            raise ValueError("heartbeat and stale thresholds must be positive")
        if depth_levels not in {5, 10, 20}:
            raise ValueError("depth_levels must be one of 5, 10, or 20")
        normalized_symbols = tuple(dict.fromkeys(str(item).strip() for item in symbols))
        if not normalized_symbols or any(not item for item in normalized_symbols):
            raise ValueError("at least one non-empty symbol is required")
        disconnects = tuple(sorted(float(value) for value in disconnect_at_seconds))
        if any(value <= 0 or value >= duration_seconds for value in disconnects):
            raise ValueError("disconnect injections must fall inside the duration")
        self.exchange_id = exchange_id.strip().lower()
        self.market_type = market_type.strip().lower()
        self.symbols = normalized_symbols
        self.interval = interval
        self.depth_levels = depth_levels
        self.duration_seconds = float(duration_seconds)
        self.startup_timeout_seconds = float(startup_timeout_seconds)
        self.heartbeat_seconds = float(heartbeat_seconds)
        self.stale_after_seconds = float(stale_after_seconds)
        self.disconnect_at_seconds = disconnects
        self.progress_path = progress_path
        self.config = IngestionConfig(
            ccxt_unified_stream_enabled=True,
            ws_stale_timeout=max(30.0, min(stale_after_seconds, 120.0)),
            ws_reconnect_delay_initial=0.25,
            ws_reconnect_delay_max=5.0,
        )
        self.pool = CcxtRuntimePool()
        self.sessions: dict[str, CcxtProviderSession] = {}
        self.audits: dict[str, UnifiedStreamAudit] = {}
        self.health: dict[str, UnifiedHealthAudit] = {}
        self.disconnects: list[dict[str, Any]] = []
        self.fatal_errors: list[dict[str, Any]] = []
        self._started_at_ms: int | None = None
        self._observation_started_at_ms: int | None = None
        self._completed_at_ms: int | None = None
        self._completed_duration = False
        self._ready = False
        self._shutdown: dict[str, Any] = {"completed": False}

    async def run(self) -> dict[str, Any]:
        self._started_at_ms = int(time.time() * 1000)
        observation_start = 0.0
        try:
            self._build_sessions()
            await asyncio.gather(*(session.start() for session in self.sessions.values()))
            await self._wait_until_ready()
            self._ready = True
            observation_start = time.monotonic()
            self._observation_started_at_ms = int(time.time() * 1000)
            await self._observe(observation_start)
            self._completed_duration = True
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - evidence must preserve failures
            logger.exception("Generic CCXT unified soak failed")
            self.fatal_errors.append(
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "observed_at_ms": int(time.time() * 1000),
                }
            )
        finally:
            await self._stop()
            self._completed_at_ms = int(time.time() * 1000)
        report = self._report(observation_start)
        self._write_progress(report)
        return report

    def _build_sessions(self) -> None:
        entry = get_ccxt_catalog_entry(self.exchange_id)
        for symbol in self.symbols:
            descriptors = (
                StreamDescriptor(
                    symbol,
                    StreamType.KLINE,
                    interval=self.interval,
                    exchange=self.exchange_id,
                    market_type=self.market_type,
                ),
                StreamDescriptor(
                    symbol,
                    StreamType.TRADE,
                    exchange=self.exchange_id,
                    market_type=self.market_type,
                ),
                StreamDescriptor(
                    symbol,
                    StreamType.DEPTH,
                    depth_levels=self.depth_levels,
                    exchange=self.exchange_id,
                    market_type=self.market_type,
                ),
                StreamDescriptor(
                    symbol,
                    StreamType.TICKER,
                    exchange=self.exchange_id,
                    market_type=self.market_type,
                ),
            )
            for descriptor in descriptors:
                descriptor.validate()
                profile = CcxtUnifiedProfile(entry, self.market_type)
                session = CcxtProviderSession(
                    config=self.config,
                    descriptor=descriptor,
                    profile=profile,
                    pool=self.pool,
                )
                audit = UnifiedStreamAudit(descriptor)
                health = UnifiedHealthAudit()
                normalizer = CcxtUnifiedNormalizer(descriptor)

                async def on_message(
                    message: RawMessage,
                    *,
                    selected_audit: UnifiedStreamAudit = audit,
                    selected_normalizer: CcxtUnifiedNormalizer = normalizer,
                ) -> None:
                    selected_audit.observe_raw(message, selected_normalizer)

                async def on_health(
                    state: SessionHealth,
                    reason: str,
                    *,
                    selected_health: UnifiedHealthAudit = health,
                ) -> None:
                    selected_health.observe(state, reason)

                session.on_message(on_message)
                session.on_health_change(on_health)
                self.sessions[descriptor.key] = session
                self.audits[descriptor.key] = audit
                self.health[descriptor.key] = health

    async def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + self.startup_timeout_seconds
        while time.monotonic() < deadline:
            if all(audit.events > 0 for audit in self.audits.values()) and all(
                session.health == SessionHealth.CONNECTED
                for session in self.sessions.values()
            ):
                return
            await asyncio.sleep(0.1)
        missing = [key for key, audit in self.audits.items() if audit.events <= 0]
        unhealthy = [
            key
            for key, session in self.sessions.items()
            if session.health != SessionHealth.CONNECTED
        ]
        raise TimeoutError(
            f"unified soak startup timeout; missing={missing}, unhealthy={unhealthy}"
        )

    async def _observe(self, observation_start: float) -> None:
        deadline = observation_start + self.duration_seconds
        next_heartbeat = observation_start
        next_disconnect = 0
        while time.monotonic() < deadline:
            now = time.monotonic()
            elapsed = now - observation_start
            if (
                next_disconnect < len(self.disconnect_at_seconds)
                and elapsed >= self.disconnect_at_seconds[next_disconnect]
            ):
                await self._inject_disconnect(elapsed)
                next_disconnect += 1
            self._update_disconnect_recovery()
            if now >= next_heartbeat:
                self._write_progress(self._report(observation_start))
                next_heartbeat = now + self.heartbeat_seconds
            await asyncio.sleep(min(0.25, max(0.0, deadline - time.monotonic())))

    async def _inject_disconnect(self, elapsed: float) -> None:
        before = {key: audit.events for key, audit in self.audits.items()}
        recycled = await self.pool.recycle_all_websockets()
        if not recycled or sum(recycled.values()) <= 0:
            raise RuntimeError("disconnect injection found no live CCXT websocket clients")
        self.disconnects.append(
            {
                "scheduled_at_seconds": self.disconnect_at_seconds[len(self.disconnects)],
                "injected_at_seconds": round(elapsed, 3),
                "injected_at_ms": int(time.time() * 1000),
                "closed_clients": recycled,
                "before_events": before,
                "recovered": False,
                "recovered_at_ms": None,
            }
        )

    def _update_disconnect_recovery(self) -> None:
        for fault in self.disconnects:
            if fault["recovered"]:
                continue
            before = fault["before_events"]
            if all(self.audits[key].events > int(count) for key, count in before.items()) and all(
                session.health == SessionHealth.CONNECTED
                for session in self.sessions.values()
            ):
                fault["recovered"] = True
                fault["recovered_at_ms"] = int(time.time() * 1000)

    async def _stop(self) -> None:
        errors = await asyncio.gather(
            *(session.stop() for session in self.sessions.values()),
            return_exceptions=True,
        )
        await asyncio.sleep(0)
        residual = sorted(
            task.get_name()
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and not task.done()
            and task.get_name().startswith("ccxt_")
        )
        stop_errors = [
            f"{type(error).__name__}: {error}"
            for error in errors
            if isinstance(error, BaseException)
        ]
        self._shutdown = {
            "completed": not stop_errors and not residual and not self.pool.snapshot()["runtimes"],
            "stop_errors": stop_errors,
            "residual_ccxt_tasks": residual,
            "pool": self.pool.snapshot(),
            "session_health": {
                key: session.health.value for key, session in self.sessions.items()
            },
        }

    def _report(self, observation_start: float) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        elapsed = max(0.0, time.monotonic() - observation_start) if observation_start else 0.0
        report: dict[str, Any] = {
            "schema_version": UNIFIED_SOAK_SCHEMA_VERSION,
            "overall_verdict": "RUNNING",
            "ready": self._ready,
            "completed_duration": self._completed_duration,
            "started_at_ms": self._started_at_ms,
            "observation_started_at_ms": self._observation_started_at_ms,
            "completed_at_ms": self._completed_at_ms,
            "elapsed_seconds": round(elapsed, 3),
            "config": {
                "exchange": self.exchange_id,
                "market_type": self.market_type,
                "symbols": list(self.symbols),
                "channels": ["kline", "trade", "depth", "ticker"],
                "interval": self.interval,
                "depth_levels": self.depth_levels,
                "duration_seconds": self.duration_seconds,
                "startup_timeout_seconds": self.startup_timeout_seconds,
                "heartbeat_seconds": self.heartbeat_seconds,
                "stale_after_seconds": self.stale_after_seconds,
                "disconnect_at_seconds": list(self.disconnect_at_seconds),
            },
            "streams": {key: audit.to_dict() for key, audit in self.audits.items()},
            "health": {key: asdict(audit) for key, audit in self.health.items()},
            "sessions": {key: session.snapshot() for key, session in self.sessions.items()},
            "fault_injection": {
                "requested": len(self.disconnect_at_seconds),
                "completed": len(self.disconnects),
                "faults": self.disconnects,
            },
            "runtime_pool": self.pool.snapshot(),
            "shutdown": self._shutdown,
            "fatal_errors": self.fatal_errors,
            "observed_at_ms": now_ms,
        }
        failures = unified_soak_failure_reasons(report)
        report["failure_reasons"] = failures
        if self._completed_at_ms is not None:
            report["overall_verdict"] = "PASS" if not failures else "FAIL"
        return report

    def _write_progress(self, report: dict[str, Any]) -> None:
        if self.progress_path is None:
            return
        self.progress_path.parent.mkdir(parents=True, exist_ok=True)
        self.progress_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


def unified_soak_failure_reasons(report: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if not report.get("ready"):
        failures.append("startup_not_ready")
    if report.get("fatal_errors"):
        failures.append("fatal_errors")
    if not report.get("completed_duration"):
        failures.append("duration_incomplete")
    config = report.get("config") or {}
    stale_after_ms = float(config.get("stale_after_seconds") or 0) * 1000
    observed_at_ms = int(report.get("observed_at_ms") or 0)
    for key, stream in (report.get("streams") or {}).items():
        if int(stream.get("events") or 0) <= 0:
            failures.append(f"no_events:{key}")
        if int(stream.get("parse_failures") or 0) > 0:
            failures.append(f"parse_failures:{key}")
        if int(stream.get("validation_failures") or 0) > 0:
            failures.append(f"validation_failures:{key}")
        if int(stream.get("duplicates") or 0) > 0:
            failures.append(f"duplicates:{key}")
        if int(stream.get("regressions") or 0) > 0:
            failures.append(f"regressions:{key}")
        last_event = stream.get("last_event_at_ms")
        if (
            stale_after_ms > 0
            and isinstance(last_event, int)
            and observed_at_ms - last_event > stale_after_ms
        ):
            failures.append(f"stale:{key}")
    faults = report.get("fault_injection") or {}
    if int(faults.get("completed") or 0) != int(faults.get("requested") or 0):
        failures.append("fault_injection_incomplete")
    for index, fault in enumerate(faults.get("faults") or []):
        if not fault.get("recovered"):
            failures.append(f"fault_not_recovered:{index}")
    if report.get("completed_at_ms") is not None and not (report.get("shutdown") or {}).get(
        "completed"
    ):
        failures.append("shutdown_incomplete")
    return failures


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _integer(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _level_price(level: Any) -> float | None:
    if not isinstance(level, (list, tuple)) or not level:
        return None
    return _number(level[0])
