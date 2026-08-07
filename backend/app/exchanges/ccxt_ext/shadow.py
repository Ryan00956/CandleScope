from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
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

from .binance_usdm import CandleScopeBinanceUSDM
from .models import CcxtLifecycleEvent, CcxtRawMarketEvent

SHADOW_SCHEMA_VERSION = "candlescope.ccxt-shadow.binance-usdm/1"
_SOURCES = ("native", "ccxt")
_CHANNELS = ("kline", "aggTrade", "depth")
_REQUIRED_FIELDS = {
    "kline": ("e", "E", "s", "k"),
    "aggTrade": ("e", "E", "s", "a", "p", "q", "f", "l", "T", "m"),
    "depth": ("e", "E", "s", "U", "u", "pu", "b", "a"),
}
_KLINE_FIELDS = (
    "t",
    "T",
    "s",
    "i",
    "f",
    "L",
    "o",
    "c",
    "h",
    "l",
    "v",
    "n",
    "x",
    "q",
    "V",
    "Q",
)
_AGG_TRADE_FIELDS = ("a", "p", "q", "f", "l", "T", "m")
_DEPTH_FIELDS = ("U", "u", "pu", "b", "a", "T")


@dataclass(slots=True)
class _SourceChannelState:
    received: int = 0
    malformed: int = 0
    missing_required_fields: int = 0
    duplicates: int = 0
    out_of_order: int = 0
    continuity_violations: int = 0
    missing_sequence_units: int = 0
    first_received_at_ms: int | None = None
    last_received_at_ms: int | None = None
    first_sequence: int | None = None
    last_sequence: int | None = None
    strict_first_sequence: int | None = None
    strict_last_sequence: int | None = None
    latencies_ms: deque[int] = field(default_factory=deque)
    records: dict[int, str] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        latencies = sorted(self.latencies_ms)
        return {
            "received": self.received,
            "malformed": self.malformed,
            "missing_required_fields": self.missing_required_fields,
            "duplicates": self.duplicates,
            "out_of_order": self.out_of_order,
            "continuity_violations": self.continuity_violations,
            "missing_sequence_units": self.missing_sequence_units,
            "first_received_at_ms": self.first_received_at_ms,
            "last_received_at_ms": self.last_received_at_ms,
            "first_sequence": self.first_sequence,
            "last_sequence": self.last_sequence,
            "strict_first_sequence": self.strict_first_sequence,
            "strict_last_sequence": self.strict_last_sequence,
            "receive_minus_exchange_event_ms": {
                "samples": len(latencies),
                "min": latencies[0] if latencies else None,
                "p50": _percentile(latencies, 0.50),
                "p95": _percentile(latencies, 0.95),
                "p99": _percentile(latencies, 0.99),
                "max": latencies[-1] if latencies else None,
            },
        }


@dataclass(slots=True)
class _StrictPairState:
    pending: dict[str, dict[int, str]] = field(
        default_factory=lambda: {source: {} for source in _SOURCES}
    )
    paired_recent: set[int] = field(default_factory=set)
    paired_order: deque[int] = field(default_factory=deque)
    shared_records: int = 0
    payload_matches: int = 0
    payload_mismatches: int = 0
    mismatch_sequences: list[int] = field(default_factory=list)
    unpaired_evictions: dict[str, int] = field(
        default_factory=lambda: {source: 0 for source in _SOURCES}
    )


class BinanceCcxtShadowComparator:
    """Compare raw native and CCXT Binance USD-M streams without production wiring."""

    def __init__(self, *, max_records_per_channel: int = 100_000) -> None:
        self._max_records = max(100, int(max_records_per_channel))
        self._states = {
            source: {
                channel: _SourceChannelState(
                    latencies_ms=deque(maxlen=self._max_records)
                )
                for channel in _CHANNELS
            }
            for source in _SOURCES
        }
        self._strict_pairs = {channel: _StrictPairState() for channel in _CHANNELS}

    def observe(
        self,
        source: str,
        channel: str,
        payload: Any,
        received_at_ms: int,
    ) -> None:
        if source not in self._states:
            raise ValueError(f"unknown shadow source: {source}")
        if channel not in self._states[source]:
            raise ValueError(f"unknown shadow channel: {channel}")
        state = self._states[source][channel]
        state.received += 1
        state.first_received_at_ms = state.first_received_at_ms or received_at_ms
        state.last_received_at_ms = received_at_ms
        if not isinstance(payload, dict):
            state.malformed += 1
            return
        if _missing_required(channel, payload):
            state.missing_required_fields += 1
            return

        exchange_time = _optional_int(payload.get("E"))
        if exchange_time is not None:
            state.latencies_ms.append(received_at_ms - exchange_time)

        sequence, fingerprint, closed = _record(channel, payload)
        if sequence is None or fingerprint is None:
            state.malformed += 1
            return

        previous = state.last_sequence
        if channel == "aggTrade" and previous is not None:
            if sequence == previous:
                state.duplicates += 1
            elif sequence < previous:
                state.out_of_order += 1
            elif sequence > previous + 1:
                state.continuity_violations += 1
                state.missing_sequence_units += sequence - previous - 1
        elif channel == "depth" and previous is not None:
            previous_link = _optional_int(payload.get("pu"))
            if sequence == previous:
                state.duplicates += 1
            elif sequence < previous:
                state.out_of_order += 1
            elif previous_link != previous:
                state.continuity_violations += 1

        if state.first_sequence is None:
            state.first_sequence = sequence
        if previous is None or sequence > previous:
            state.last_sequence = sequence
        _bounded_put(state.records, sequence, fingerprint, self._max_records)
        if channel != "kline" or closed:
            if state.strict_first_sequence is None:
                state.strict_first_sequence = sequence
            if (
                state.strict_last_sequence is None
                or sequence > state.strict_last_sequence
            ):
                state.strict_last_sequence = sequence
            self._observe_strict_pair(source, channel, sequence, fingerprint)

    def ready(self) -> bool:
        return all(
            self._states[source][channel].received > 0
            for source in _SOURCES
            for channel in _CHANNELS
        )

    def report(self) -> dict[str, Any]:
        channels = {channel: self._channel_report(channel) for channel in _CHANNELS}
        verdicts = [value["verdict"] for value in channels.values()]
        overall = (
            "FAIL"
            if "FAIL" in verdicts
            else (
                "PASS"
                if verdicts and all(value == "PASS" for value in verdicts)
                else "INCONCLUSIVE"
            )
        )
        return {
            "schema_version": SHADOW_SCHEMA_VERSION,
            "overall_verdict": overall,
            "timing_note": (
                "receive_minus_exchange_event_ms includes host/exchange clock offset; "
                "negative values are not treated as negative network latency"
            ),
            "channels": channels,
        }

    def _observe_strict_pair(
        self,
        source: str,
        channel: str,
        sequence: int,
        fingerprint: str,
    ) -> None:
        pair = self._strict_pairs[channel]
        if sequence in pair.paired_recent:
            return
        other_source = "ccxt" if source == "native" else "native"
        other_fingerprint = pair.pending[other_source].pop(sequence, None)
        if other_fingerprint is None:
            own_pending = pair.pending[source]
            if sequence not in own_pending and len(own_pending) >= self._max_records:
                own_pending.pop(next(iter(own_pending)))
                pair.unpaired_evictions[source] += 1
            own_pending[sequence] = fingerprint
            return

        pair.pending[source].pop(sequence, None)
        pair.shared_records += 1
        if fingerprint == other_fingerprint:
            pair.payload_matches += 1
        else:
            pair.payload_mismatches += 1
            if len(pair.mismatch_sequences) < 20:
                pair.mismatch_sequences.append(sequence)
        pair.paired_recent.add(sequence)
        pair.paired_order.append(sequence)
        if len(pair.paired_order) > self._max_records:
            pair.paired_recent.discard(pair.paired_order.popleft())

    def _strict_comparison(self, channel: str) -> dict[str, Any]:
        pair = self._strict_pairs[channel]
        native = self._states["native"][channel]
        ccxt = self._states["ccxt"][channel]
        starts = (native.strict_first_sequence, ccxt.strict_first_sequence)
        ends = (native.strict_last_sequence, ccxt.strict_last_sequence)
        if None in starts or None in ends:
            overlap_start = None
            overlap_end = None
        else:
            overlap_start = max(starts)
            overlap_end = min(ends)
            if overlap_start > overlap_end:
                overlap_start = None
                overlap_end = None

        def pending_in_overlap(source: str) -> int:
            if overlap_start is None or overlap_end is None:
                return 0
            return sum(
                overlap_start <= sequence <= overlap_end
                for sequence in pair.pending[source]
            )

        return {
            "overlap_start": overlap_start,
            "overlap_end": overlap_end,
            "shared_records": pair.shared_records,
            "payload_matches": pair.payload_matches,
            "payload_mismatches": pair.payload_mismatches,
            "native_only_in_overlap": pending_in_overlap("native"),
            "ccxt_only_in_overlap": pending_in_overlap("ccxt"),
            "mismatch_sequences": sorted(pair.mismatch_sequences),
            "unpaired_evictions": dict(pair.unpaired_evictions),
        }

    def _channel_report(self, channel: str) -> dict[str, Any]:
        native = self._states["native"][channel]
        ccxt = self._states["ccxt"][channel]
        strict_comparison = self._strict_comparison(channel)
        live_comparison = _compare_records(native.records, ccxt.records)
        reasons: list[str] = []
        for source, state in (("native", native), ("ccxt", ccxt)):
            if state.received == 0:
                reasons.append(f"{source}_no_messages")
            if state.malformed:
                reasons.append(f"{source}_malformed")
            if state.missing_required_fields:
                reasons.append(f"{source}_missing_required_fields")
            if state.continuity_violations:
                reasons.append(f"{source}_continuity_violation")
            if state.out_of_order:
                reasons.append(f"{source}_out_of_order")
            if strict_comparison["unpaired_evictions"][source]:
                reasons.append(f"{source}_unpaired_eviction")

        hard_comparison_failure = any(
            strict_comparison[key] > 0
            for key in (
                "payload_mismatches",
                "native_only_in_overlap",
                "ccxt_only_in_overlap",
            )
        )
        if hard_comparison_failure:
            reasons.append("overlap_mismatch")

        if reasons:
            verdict = "FAIL"
        elif strict_comparison["shared_records"] == 0:
            verdict = "INCONCLUSIVE"
            reasons.append(
                "no_shared_closed_kline" if channel == "kline" else "no_shared_sequence"
            )
        else:
            verdict = "PASS"

        return {
            "verdict": verdict,
            "reasons": reasons,
            "strict_basis": "closed_kline"
            if channel == "kline"
            else "exchange_sequence",
            "sources": {
                "native": native.to_wire(),
                "ccxt": ccxt.to_wire(),
            },
            "strict_comparison": strict_comparison,
            "live_diagnostic_comparison": live_comparison,
        }


class BinanceCcxtShadowRunner:
    """Run native CandleScope and CCXT feeds side by side for one USD-M symbol."""

    def __init__(
        self,
        *,
        symbol: str = "BTCUSDT",
        ccxt_symbol: str | None = None,
        interval: str = "1m",
        depth_update_interval_ms: int = 100,
        duration_seconds: float = 65.0,
        startup_timeout_seconds: float = 30.0,
        config: IngestionConfig | None = None,
    ) -> None:
        if duration_seconds <= 0 or startup_timeout_seconds <= 0:
            raise ValueError("shadow durations must be positive")
        self.symbol = str(symbol).upper().strip()
        self.ccxt_symbol = ccxt_symbol or _ccxt_symbol_from_native(self.symbol)
        self.interval = interval
        self.depth_update_interval_ms = int(depth_update_interval_ms)
        self.duration_seconds = float(duration_seconds)
        self.startup_timeout_seconds = float(startup_timeout_seconds)
        self.config = config or IngestionConfig()
        self.comparator = BinanceCcxtShadowComparator()
        self._running = False
        self._fatal_errors: list[dict[str, Any]] = []
        self._ccxt_errors: list[dict[str, Any]] = []
        self._native_lifecycle: list[dict[str, Any]] = []
        self._ccxt_lifecycle: list[dict[str, Any]] = []

    async def run(self) -> dict[str, Any]:
        started_at_ms = int(time.time() * 1000)
        transport = TransportLayer(self.config)
        sessions = self._native_sessions(transport)
        ccxt_exchange = CandleScopeBinanceUSDM(
            self._ccxt_config(),
            raw_event_sink=self._on_ccxt_raw,
            lifecycle_sink=self._on_ccxt_lifecycle,
        )
        ccxt_tasks: list[asyncio.Task[Any]] = []
        ready = False
        try:
            await transport.start()
            await asyncio.wait_for(
                ccxt_exchange.load_markets(),
                timeout=self.startup_timeout_seconds,
            )
            for session in sessions:
                await session.start()
            self._running = True
            ccxt_tasks = [
                asyncio.create_task(
                    self._watch_kline(ccxt_exchange), name="ccxt_shadow_kline"
                ),
                asyncio.create_task(
                    self._watch_agg_trade(ccxt_exchange), name="ccxt_shadow_agg_trade"
                ),
                asyncio.create_task(
                    self._watch_depth(ccxt_exchange), name="ccxt_shadow_depth"
                ),
            ]
            ready = await self._wait_until_ready()
            if ready:
                await asyncio.sleep(self.duration_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - fatal runtime evidence belongs in report
            self._fatal_errors.append(
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "observed_at_ms": int(time.time() * 1000),
                }
            )
        finally:
            self._running = False
            for task in ccxt_tasks:
                task.cancel()
            if ccxt_tasks:
                await asyncio.gather(*ccxt_tasks, return_exceptions=True)
            await asyncio.gather(
                *(session.stop() for session in sessions), return_exceptions=True
            )
            await ccxt_exchange.close()
            await transport.stop()

        completed_at_ms = int(time.time() * 1000)
        report = self.comparator.report()
        if (not ready or self._fatal_errors) and report["overall_verdict"] != "FAIL":
            report["overall_verdict"] = "FAIL"
        report.update(
            {
                "started_at_ms": started_at_ms,
                "completed_at_ms": completed_at_ms,
                "elapsed_seconds": round((completed_at_ms - started_at_ms) / 1000, 3),
                "ready": ready,
                "config": {
                    "symbol": self.symbol,
                    "ccxt_symbol": self.ccxt_symbol,
                    "market_type": "futures",
                    "interval": self.interval,
                    "depth_update_interval_ms": self.depth_update_interval_ms,
                    "duration_seconds": self.duration_seconds,
                    "startup_timeout_seconds": self.startup_timeout_seconds,
                },
                "runtime": {
                    "native_lifecycle": self._native_lifecycle,
                    "ccxt_lifecycle": self._ccxt_lifecycle,
                    "ccxt_errors": self._ccxt_errors,
                    "fatal_errors": self._fatal_errors,
                },
            }
        )
        return report

    def _native_sessions(self, transport: TransportLayer) -> list[SessionLayer]:
        descriptors = (
            (
                "kline",
                StreamDescriptor(
                    self.symbol,
                    StreamType.KLINE,
                    interval=self.interval,
                    market_type="futures",
                ),
            ),
            (
                "aggTrade",
                StreamDescriptor(
                    self.symbol,
                    StreamType.AGG_TRADE,
                    market_type="futures",
                ),
            ),
            (
                "depth",
                StreamDescriptor(
                    self.symbol,
                    StreamType.FULL_DEPTH,
                    market_type="futures",
                    update_interval_ms=self.depth_update_interval_ms,
                ),
            ),
        )
        sessions: list[SessionLayer] = []
        for channel, descriptor in descriptors:
            session = SessionLayer(self.config, transport, descriptor)

            async def on_message(
                message: RawMessage, *, event_channel: str = channel
            ) -> None:
                self.comparator.observe(
                    "native",
                    event_channel,
                    message.payload,
                    message.received_at_ms,
                )

            async def on_health(
                health: SessionHealth,
                reason: str,
                *,
                event_channel: str = channel,
            ) -> None:
                self._native_lifecycle.append(
                    {
                        "channel": event_channel,
                        "state": health.value,
                        "reason": reason,
                        "observed_at_ms": int(time.time() * 1000),
                    }
                )

            session.on_message(on_message)
            session.on_health_change(on_health)
            sessions.append(session)
        return sessions

    async def _watch_kline(self, exchange: CandleScopeBinanceUSDM) -> None:
        await self._watch_loop(
            "kline",
            lambda: exchange.watch_ohlcv(self.ccxt_symbol, self.interval),
        )

    async def _watch_agg_trade(self, exchange: CandleScopeBinanceUSDM) -> None:
        await self._watch_loop(
            "aggTrade",
            lambda: exchange.watch_trades(
                self.ccxt_symbol,
                params={"name": "aggTrade"},
            ),
        )

    async def _watch_depth(self, exchange: CandleScopeBinanceUSDM) -> None:
        await self._watch_loop(
            "depth",
            lambda: exchange.watch_order_book(
                self.ccxt_symbol,
                limit=100,
                params={"rate": self.depth_update_interval_ms},
            ),
        )

    async def _watch_loop(self, channel: str, watch: Any) -> None:
        delay = 0.25
        while self._running:
            try:
                await watch()
                delay = 0.25
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - shadow records every provider failure
                self._ccxt_errors.append(
                    {
                        "channel": channel,
                        "type": type(exc).__name__,
                        "message": str(exc),
                        "observed_at_ms": int(time.time() * 1000),
                    }
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 5.0)

    async def _wait_until_ready(self) -> bool:
        deadline = asyncio.get_running_loop().time() + self.startup_timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            if self.comparator.ready():
                return True
            await asyncio.sleep(0.05)
        return self.comparator.ready()

    def _on_ccxt_raw(self, event: CcxtRawMarketEvent) -> None:
        if event.channel not in _CHANNELS:
            return
        self.comparator.observe(
            "ccxt",
            event.channel,
            event.payload,
            event.received_at_ms,
        )

    def _on_ccxt_lifecycle(self, event: CcxtLifecycleEvent) -> None:
        self._ccxt_lifecycle.append(
            {
                "state": event.state,
                "url": event.url,
                "error": event.error,
                "observed_at_ms": event.observed_at_ms,
            }
        )

    def _ccxt_config(self) -> dict[str, Any]:
        values: dict[str, Any] = {
            "newUpdates": True,
            "enableRateLimit": True,
            "aiohttp_trust_env": self.config.proxy_mode == "system",
        }
        proxy = self.config.http_proxy
        if proxy and self.config.proxy_mode != "none":
            values["httpsProxy"] = proxy
            values["wssProxy"] = proxy
        return values


def _missing_required(channel: str, payload: Mapping[str, Any]) -> bool:
    if any(field not in payload for field in _REQUIRED_FIELDS[channel]):
        return True
    if channel != "kline":
        return False
    kline = payload.get("k")
    return not isinstance(kline, dict) or any(
        field not in kline for field in _KLINE_FIELDS
    )


def _record(
    channel: str, payload: Mapping[str, Any]
) -> tuple[int | None, str | None, bool]:
    if channel == "kline":
        kline = payload.get("k")
        if not isinstance(kline, dict):
            return None, None, False
        sequence = _optional_int(kline.get("t"))
        comparable = {key: kline.get(key) for key in _KLINE_FIELDS}
        closed = bool(kline.get("x"))
    elif channel == "aggTrade":
        sequence = _optional_int(payload.get("a"))
        comparable = {key: payload.get(key) for key in _AGG_TRADE_FIELDS}
        closed = True
    else:
        sequence = _optional_int(payload.get("u"))
        comparable = {key: payload.get(key) for key in _DEPTH_FIELDS}
        closed = True
    if sequence is None:
        return None, None, closed
    encoded = json.dumps(
        comparable, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return sequence, hashlib.sha256(encoded.encode("utf-8")).hexdigest(), closed


def _bounded_put(records: dict[int, str], key: int, value: str, maximum: int) -> None:
    if key not in records and len(records) >= maximum:
        records.pop(next(iter(records)))
    records[key] = value


def _compare_records(
    native: Mapping[int, str], ccxt: Mapping[int, str]
) -> dict[str, Any]:
    if not native or not ccxt:
        return {
            "overlap_start": None,
            "overlap_end": None,
            "shared_records": 0,
            "payload_matches": 0,
            "payload_mismatches": 0,
            "native_only_in_overlap": 0,
            "ccxt_only_in_overlap": 0,
            "mismatch_sequences": [],
        }
    overlap_start = max(min(native), min(ccxt))
    overlap_end = min(max(native), max(ccxt))
    if overlap_start > overlap_end:
        native_window: set[int] = set()
        ccxt_window: set[int] = set()
    else:
        native_window = {key for key in native if overlap_start <= key <= overlap_end}
        ccxt_window = {key for key in ccxt if overlap_start <= key <= overlap_end}
    shared = native_window & ccxt_window
    mismatches = sorted(key for key in shared if native[key] != ccxt[key])
    return {
        "overlap_start": overlap_start if overlap_start <= overlap_end else None,
        "overlap_end": overlap_end if overlap_start <= overlap_end else None,
        "shared_records": len(shared),
        "payload_matches": len(shared) - len(mismatches),
        "payload_mismatches": len(mismatches),
        "native_only_in_overlap": len(native_window - ccxt_window),
        "ccxt_only_in_overlap": len(ccxt_window - native_window),
        "mismatch_sequences": mismatches[:20],
    }


def _percentile(values: list[int], percentile: float) -> int | None:
    if not values:
        return None
    index = min(len(values) - 1, max(0, math.ceil(len(values) * percentile) - 1))
    return values[index]


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ccxt_symbol_from_native(symbol: str) -> str:
    normalized = str(symbol).upper().strip()
    if not normalized.endswith("USDT") or len(normalized) <= 4:
        raise ValueError(
            "automatic CCXT symbol conversion currently requires a USDT pair"
        )
    return f"{normalized[:-4]}/USDT:USDT"
