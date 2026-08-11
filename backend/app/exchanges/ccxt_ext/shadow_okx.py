"""Strict raw parity comparator for the currently exposed OKX channels."""

from __future__ import annotations

import hashlib
import json
from collections import deque
from collections.abc import Mapping
from typing import Any

from .shadow import (
    _SOURCES,
    _SourceChannelState,
    _StrictPairState,
    _bounded_put,
    _compare_records,
    _optional_int,
)

OKX_SHADOW_SCHEMA_VERSION = "candlescope.ccxt-shadow.okx-swap/1"
OKX_SPOT_SHADOW_SCHEMA_VERSION = "candlescope.ccxt-shadow.okx-spot/1"
OKX_SHADOW_CHANNELS = ("kline", "ticker")


class OkxCcxtShadowComparator:
    """Compare closed candles and timestamped ticker payloads exactly."""

    def __init__(
        self,
        *,
        market_type: str = "futures",
        max_records_per_channel: int = 100_000,
    ) -> None:
        normalized_market_type = str(market_type).lower().strip()
        if normalized_market_type not in {"futures", "spot"}:
            raise ValueError("OKX shadow market_type must be spot or futures")
        self.market_type = normalized_market_type
        self._max_records = max(100, int(max_records_per_channel))
        self._states = {
            source: {
                channel: _SourceChannelState(
                    latencies_ms=deque(maxlen=self._max_records)
                )
                for channel in OKX_SHADOW_CHANNELS
            }
            for source in _SOURCES
        }
        self._strict_pairs = {
            channel: _StrictPairState() for channel in OKX_SHADOW_CHANNELS
        }

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
            raise ValueError(f"unknown OKX shadow channel: {channel}")
        state = self._states[source][channel]
        state.received += 1
        state.first_received_at_ms = state.first_received_at_ms or received_at_ms
        state.last_received_at_ms = received_at_ms
        if not isinstance(payload, dict):
            state.malformed += 1
            return

        sequence, fingerprint, closed, exchange_time = _okx_record(channel, payload)
        if sequence is None or fingerprint is None:
            state.malformed += 1
            return
        if exchange_time is not None:
            state.latencies_ms.append(received_at_ms - exchange_time)

        previous = state.last_sequence
        if channel == "ticker" and previous is not None:
            if sequence == previous:
                state.duplicates += 1
            elif sequence < previous:
                state.out_of_order += 1

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
            for channel in OKX_SHADOW_CHANNELS
        )

    def report(self) -> dict[str, Any]:
        channels = {
            channel: self._channel_report(channel) for channel in OKX_SHADOW_CHANNELS
        }
        verdicts = [report["verdict"] for report in channels.values()]
        overall = (
            "FAIL"
            if "FAIL" in verdicts
            else (
                "PASS"
                if verdicts and all(verdict == "PASS" for verdict in verdicts)
                else "INCONCLUSIVE"
            )
        )
        return {
            "schema_version": (
                OKX_SHADOW_SCHEMA_VERSION
                if self.market_type == "futures"
                else OKX_SPOT_SHADOW_SCHEMA_VERSION
            ),
            "overall_verdict": overall,
            "timing_note": (
                "ticker receive_minus_exchange_event_ms includes clock offset; "
                "OKX candles expose bucket time rather than event time"
            ),
            "channels": channels,
        }

    def _observe_strict_pair(
        self, source: str, channel: str, sequence: int, fingerprint: str
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
        strict = self._strict_comparison(channel)
        reasons: list[str] = []
        for source, state in (("native", native), ("ccxt", ccxt)):
            if state.received == 0:
                reasons.append(f"{source}_no_messages")
            if state.malformed:
                reasons.append(f"{source}_malformed")
            if state.out_of_order:
                reasons.append(f"{source}_out_of_order")
            if strict["unpaired_evictions"][source]:
                reasons.append(f"{source}_unpaired_eviction")
        if any(
            strict[key] > 0
            for key in (
                "payload_mismatches",
                "native_only_in_overlap",
                "ccxt_only_in_overlap",
            )
        ):
            reasons.append("overlap_mismatch")

        if reasons:
            verdict = "FAIL"
        elif strict["shared_records"] == 0:
            verdict = "INCONCLUSIVE"
            reasons.append(
                "no_shared_closed_kline"
                if channel == "kline"
                else "no_shared_timestamp"
            )
        else:
            verdict = "PASS"
        return {
            "verdict": verdict,
            "reasons": reasons,
            "strict_basis": (
                "closed_kline" if channel == "kline" else "exchange_timestamp"
            ),
            "sources": {"native": native.to_wire(), "ccxt": ccxt.to_wire()},
            "strict_comparison": strict,
            "live_diagnostic_comparison": _compare_records(
                native.records, ccxt.records
            ),
        }


def _okx_record(
    channel: str, payload: Mapping[str, Any]
) -> tuple[int | None, str | None, bool, int | None]:
    arg = payload.get("arg")
    rows = payload.get("data")
    if not isinstance(arg, Mapping) or not isinstance(rows, list) or len(rows) != 1:
        return None, None, False, None
    row = rows[0]
    if channel == "kline":
        if not isinstance(row, list) or len(row) < 9:
            return None, None, False, None
        sequence = _optional_int(row[0])
        closed = str(row[8]) == "1"
        exchange_time = None
    else:
        if not isinstance(row, Mapping):
            return None, None, False, None
        sequence = _optional_int(row.get("ts"))
        closed = True
        exchange_time = sequence
    if sequence is None:
        return None, None, closed, exchange_time
    encoded = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    fingerprint = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return sequence, fingerprint, closed, exchange_time
