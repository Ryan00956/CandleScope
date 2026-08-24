"""Deterministic decision-time trade evidence and compatible Run comparison.

The explanation payload is deliberately small and self-verifying.  It never
reconstructs a strategy reason from later fills: callers must supply a bounded
provider trace captured at the decision watermark.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from collections import Counter
from decimal import Decimal, InvalidOperation
from typing import Mapping, Sequence

from app.backtest.strategy.protocol import PROTOCOL


TRADE_EXPLANATION_SCHEMA = "TRADE_EXPLANATION_V1"
TRADE_FINGERPRINT_SCHEMA = "TRADE_FINGERPRINT_V2"
RUN_COMPARE_SCHEMA = "RUN_COMPARE_V3"
CANONICALIZATION = "JCS_SHA256_V1"
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_CONDITIONS = 64
MAX_VARIABLES = 128
MAX_KEY_BYTES = 128
MAX_STRING_BYTES = 2 * 1024


class TradeExplanationError(ValueError):
    """Raised when an explanation cannot satisfy the frozen wire contract."""


def _utf16_key(value: str) -> bytes:
    try:
        return value.encode("utf-16-be", errors="strict")
    except UnicodeEncodeError as exc:
        raise TradeExplanationError("unpaired Unicode surrogate") from exc


def _validate_json(value: object) -> object:
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str):
            value.encode("utf-8", errors="strict")
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAX_SAFE_INTEGER:
            raise TradeExplanationError("integer exceeds JavaScript safe range")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TradeExplanationError("non-finite number")
        raise TradeExplanationError("floating point values are not canonical evidence")
    if isinstance(value, Mapping):
        ordered: dict[str, object] = {}
        keys: list[str] = []
        for raw_key in value:
            if not isinstance(raw_key, str):
                raise TradeExplanationError("object key must be a string")
            raw_key.encode("utf-8", errors="strict")
            keys.append(raw_key)
        for key in sorted(keys, key=_utf16_key):
            ordered[key] = _validate_json(value[key])
        return ordered
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_validate_json(item) for item in value]
    raise TradeExplanationError(f"unsupported evidence value {type(value).__name__}")


def jcs_dumps(value: object) -> str:
    """Canonical JSON for the bounded integer/string/bool/null evidence subset."""

    return json.dumps(
        _validate_json(value),
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def jcs_sha256(value: object) -> str:
    return hashlib.sha256(jcs_dumps(value).encode("utf-8")).hexdigest()


def normalize_decimal(value: object) -> str:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise TradeExplanationError("invalid decimal") from exc
    if not number.is_finite():
        raise TradeExplanationError("decimal must be finite")
    if number == 0:
        return "0"
    normalized = format(number.normalize(), "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized


def _truncate_utf8(value: str, maximum: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8", errors="strict")
    if len(encoded) <= maximum:
        return value, False
    truncated = encoded[:maximum]
    while truncated:
        try:
            return truncated.decode("utf-8"), True
        except UnicodeDecodeError:
            truncated = truncated[:-1]
    return "", True


def _bounded_text(value: object | None) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    return _truncate_utf8(str(value), MAX_STRING_BYTES)


def _typed_variable(raw: object) -> tuple[dict[str, object], bool]:
    if isinstance(raw, Mapping) and raw.get("kind") in {
        "string",
        "decimal",
        "boolean",
        "null",
    }:
        kind = str(raw["kind"])
        value = raw.get("value")
    elif raw is None:
        kind, value = "null", None
    elif isinstance(raw, bool):
        kind, value = "boolean", raw
    elif isinstance(raw, (int, Decimal)) and not isinstance(raw, bool):
        kind, value = "decimal", raw
    else:
        kind, value = "string", str(raw)
    if kind == "null":
        if value is not None:
            raise TradeExplanationError("null variable must have null value")
        return {"kind": "null", "value": None}, False
    if kind == "boolean":
        if not isinstance(value, bool):
            raise TradeExplanationError("boolean variable must have boolean value")
        return {"kind": "boolean", "value": value}, False
    if kind == "decimal":
        return {"kind": "decimal", "value": normalize_decimal(value)}, False
    text, truncated = _bounded_text(value)
    return {"kind": "string", "value": text or ""}, truncated


def _safe_int(value: object, name: str, *, nullable: bool = False) -> int | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool):
        raise TradeExplanationError(f"{name} must be an integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TradeExplanationError(f"{name} must be an integer") from exc
    if parsed < 0 or parsed > MAX_SAFE_INTEGER:
        raise TradeExplanationError(f"{name} is outside the safe integer range")
    return parsed


def _base_explanation(
    *,
    run_id: str,
    strategy_revision_id: str,
    action: str,
    decision_id: str,
    decision_time_ms: int,
    decision_trace_ordinal: int | None,
    trade_id: str | None,
    order_id: str | None,
    fill_id: str | None,
    completeness: str,
) -> dict[str, object]:
    return {
        "schema": TRADE_EXPLANATION_SCHEMA,
        "canonicalization": CANONICALIZATION,
        "runId": run_id,
        "tradeId": trade_id,
        "orderId": order_id,
        "fillId": fill_id,
        "decisionId": decision_id,
        "decisionTraceOrdinal": decision_trace_ordinal,
        "decisionTimeMs": decision_time_ms,
        "action": action,
        "reasonCode": None,
        "reasonLabel": None,
        "source": {
            "strategyRevisionId": strategy_revision_id,
            "line": None,
            "column": None,
            "conditionId": None,
        },
        "conditions": [],
        "variables": {},
        "execution": {"state": "REJECTED", "reasonCode": None},
        "completeness": completeness,
        "omissions": {
            "conditionsDropped": 0,
            "variablesDropped": 0,
            "valuesTruncated": 0,
        },
        "evidenceHash": "",
    }


def _seal(payload: Mapping[str, object]) -> dict[str, object]:
    result = copy.deepcopy(dict(payload))
    result.pop("evidenceHash", None)
    result["evidenceHash"] = jcs_sha256(result)
    return result


def unavailable_explanation(
    *,
    run_id: str,
    strategy_revision_id: str,
    action: str,
    decision_id: str,
    decision_time_ms: int,
    decision_trace_ordinal: int | None = None,
    trade_id: str | None = None,
    order_id: str | None = None,
    fill_id: str | None = None,
    execution_state: str = "REJECTED",
    execution_reason: str | None = None,
) -> dict[str, object]:
    base = _base_explanation(
        run_id=run_id,
        strategy_revision_id=strategy_revision_id,
        action=action,
        decision_id=decision_id,
        decision_time_ms=decision_time_ms,
        decision_trace_ordinal=decision_trace_ordinal,
        trade_id=trade_id,
        order_id=order_id,
        fill_id=fill_id,
        completeness="UNAVAILABLE",
    )
    base["execution"] = {"state": execution_state, "reasonCode": execution_reason}
    return _seal(base)


def build_explanation(
    *,
    run_id: str,
    strategy_revision_id: str,
    trace: Mapping[str, object] | None,
    action: str,
    trade_id: str | None,
    order_id: str | None,
    fill_id: str | None,
    execution_state: str,
    execution_reason: str | None,
) -> dict[str, object]:
    """Materialize one explanation from an already captured decision trace."""

    if trace is None:
        return unavailable_explanation(
            run_id=run_id,
            strategy_revision_id=strategy_revision_id,
            action=action,
            decision_id=f"decision-unavailable-{order_id or fill_id or 'host'}",
            decision_time_ms=0,
            trade_id=trade_id,
            order_id=order_id,
            fill_id=fill_id,
            execution_state=execution_state,
            execution_reason=execution_reason,
        )
    try:
        decision_time_ms = _safe_int(trace.get("eventTimeMs"), "decisionTimeMs")
        ordinal = _safe_int(
            trace.get("decisionTraceOrdinal"), "decisionTraceOrdinal", nullable=True
        )
        assert decision_time_ms is not None
        decision_id = str(trace.get("decisionId") or "")
        if not decision_id:
            decision_id = (
                "decision-"
                + jcs_sha256(
                    {
                        "runId": run_id,
                        "sequence": _safe_int(trace.get("sequence"), "sequence"),
                        "ordinal": ordinal,
                    }
                )[:24]
            )
        base = _base_explanation(
            run_id=run_id,
            strategy_revision_id=strategy_revision_id,
            action=action,
            decision_id=decision_id,
            decision_time_ms=decision_time_ms,
            decision_trace_ordinal=ordinal,
            trade_id=trade_id,
            order_id=order_id,
            fill_id=fill_id,
            completeness="COMPLETE",
        )
        omissions = base["omissions"]
        assert isinstance(omissions, dict)
        reason_code, truncated = _bounded_text(trace.get("reasonCode"))
        reason_label, label_truncated = _bounded_text(trace.get("reasonLabel"))
        omissions["valuesTruncated"] = int(truncated) + int(label_truncated)
        base["reasonCode"] = reason_code
        base["reasonLabel"] = reason_label
        raw_source = trace.get("source")
        raw_source = raw_source if isinstance(raw_source, Mapping) else {}
        condition_id, condition_id_truncated = _bounded_text(
            raw_source.get("conditionId")
        )
        omissions["valuesTruncated"] += int(condition_id_truncated)
        base["source"] = {
            "strategyRevisionId": strategy_revision_id,
            "line": _safe_int(raw_source.get("line"), "source.line", nullable=True),
            "column": _safe_int(
                raw_source.get("column"), "source.column", nullable=True
            ),
            "conditionId": condition_id,
        }

        raw_conditions = trace.get("conditions")
        candidates = (
            list(raw_conditions)
            if isinstance(raw_conditions, Sequence)
            and not isinstance(raw_conditions, (str, bytes, bytearray))
            else []
        )
        conditions: list[dict[str, object]] = []
        for raw in candidates[:MAX_CONDITIONS]:
            if not isinstance(raw, Mapping):
                raise TradeExplanationError("condition must be an object")
            condition_id_value, id_truncated = _bounded_text(raw.get("id"))
            label, value_truncated = _bounded_text(raw.get("label"))
            result = raw.get("result")
            if result is not None and not isinstance(result, bool):
                raise TradeExplanationError("condition result must be boolean or null")
            conditions.append(
                {"id": condition_id_value or "", "label": label or "", "result": result}
            )
            omissions["valuesTruncated"] += int(id_truncated) + int(value_truncated)
        omissions["conditionsDropped"] = max(0, len(candidates) - len(conditions))
        base["conditions"] = conditions

        raw_variables = trace.get("variables")
        raw_variables = raw_variables if isinstance(raw_variables, Mapping) else {}
        variables: dict[str, dict[str, object]] = {}
        eligible_keys = [
            key
            for key in raw_variables
            if isinstance(key, str)
            and len(key.encode("utf-8", errors="strict")) <= MAX_KEY_BYTES
        ]
        invalid_key_count = len(raw_variables) - len(eligible_keys)
        ordered_keys = sorted(eligible_keys, key=_utf16_key)
        for key in ordered_keys[:MAX_VARIABLES]:
            variable, value_truncated = _typed_variable(raw_variables[key])
            variables[key] = variable
            omissions["valuesTruncated"] += int(value_truncated)
        omissions["variablesDropped"] = invalid_key_count + max(
            0, len(ordered_keys) - len(variables)
        )
        base["variables"] = variables
        base["execution"] = {
            "state": execution_state,
            "reasonCode": _bounded_text(execution_reason)[0],
        }

        def byte_size() -> int:
            probe = dict(base)
            probe.pop("evidenceHash", None)
            return len(jcs_dumps(probe).encode("utf-8"))

        while byte_size() > MAX_PAYLOAD_BYTES and variables:
            variables.pop(next(reversed(variables)))
            omissions["variablesDropped"] += 1
        while byte_size() > MAX_PAYLOAD_BYTES and conditions:
            conditions.pop()
            omissions["conditionsDropped"] += 1
        if byte_size() > MAX_PAYLOAD_BYTES:
            raise TradeExplanationError("base explanation exceeds payload budget")
        if any(int(omissions[key]) > 0 for key in omissions):
            base["completeness"] = "PARTIAL"
        return _seal(base)
    except (TradeExplanationError, UnicodeError, ValueError, TypeError):
        return unavailable_explanation(
            run_id=run_id,
            strategy_revision_id=strategy_revision_id,
            action=action,
            decision_id=f"decision-unavailable-{order_id or fill_id or 'host'}",
            decision_time_ms=0,
            trade_id=trade_id,
            order_id=order_id,
            fill_id=fill_id,
            execution_state=execution_state,
            execution_reason=execution_reason,
        )


def verify_explanation(payload: Mapping[str, object]) -> bool:
    try:
        if payload.get("schema") != TRADE_EXPLANATION_SCHEMA:
            return False
        if payload.get("canonicalization") != CANONICALIZATION:
            return False
        expected = str(payload.get("evidenceHash") or "")
        if len(expected) != 64 or any(
            char not in "0123456789abcdef" for char in expected
        ):
            return False
        candidate = copy.deepcopy(dict(payload))
        candidate.pop("evidenceHash", None)
        if jcs_sha256(candidate) != expected:
            return False
        if payload.get("action") not in {"ENTER", "EXIT", "REVERSE", "REJECT"}:
            return False
        if payload.get("completeness") not in {"COMPLETE", "PARTIAL", "UNAVAILABLE"}:
            return False
        _safe_int(payload.get("decisionTimeMs"), "decisionTimeMs")
        _safe_int(
            payload.get("decisionTraceOrdinal"),
            "decisionTraceOrdinal",
            nullable=True,
        )
        return len(jcs_dumps(candidate).encode("utf-8")) <= MAX_PAYLOAD_BYTES
    except (TradeExplanationError, UnicodeError, ValueError, TypeError):
        return False


def bind_trade_id(
    payload: Mapping[str, object] | None, trade_id: str
) -> dict[str, object] | None:
    if not isinstance(payload, Mapping) or not verify_explanation(payload):
        return None
    bound = copy.deepcopy(dict(payload))
    bound["tradeId"] = trade_id
    return _seal(bound)


def _action_kind(value: object, *, rejection: bool = False) -> str:
    if rejection:
        return "REJECT"
    action = str(value or "").upper()
    if action.startswith("REVERSE"):
        return "REVERSE"
    if action.startswith("CLOSE") or action.startswith("REDUCE"):
        return "EXIT"
    return "ENTER"


def _decision_sequence_for_order(
    order: Mapping[str, object], config: Mapping[str, object]
) -> int:
    eligible = int(order.get("eligible_after_sequence") or 0)
    offset = 1
    if (
        str(config.get("signal_clock") or "") == "BAR_CLOSE"
        and str(config.get("execution_clock") or "") == "AGG_TRADE"
    ):
        offset += int(config.get("latency_events") or 0)
    return max(0, eligible - offset)


def enrich_execution_evidence(
    *,
    run: Mapping[str, object],
    config: Mapping[str, object],
    fills: Sequence[Mapping[str, object]],
    orders: Sequence[Mapping[str, object]],
    rejections: Sequence[Mapping[str, object]],
    trace_rows: Sequence[Mapping[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    """Attach stable decision/fill links without changing execution values."""

    run_id = str(run.get("run_id") or "")
    revision_id = str(run.get("strategy_revision_id") or "")
    trace_by_sequence = {
        int(item.get("sequence") or 0): item
        for item in trace_rows
        if isinstance(item, Mapping)
    }
    order_by_id = {str(item.get("order_id") or ""): item for item in orders}
    fill_occurrences: Counter[str] = Counter()
    action_occurrences: Counter[tuple[int, str]] = Counter()
    enriched_fills: list[dict[str, object]] = []
    for raw_fill in fills:
        fill = copy.deepcopy(dict(raw_fill))
        order_id = str(fill.get("order_id") or "")
        fill_occurrences[order_id] += 1
        fill_id = f"fill-{order_id}-{fill_occurrences[order_id]}"
        order = order_by_id.get(order_id, {})
        sequence = _decision_sequence_for_order(order, config)
        trace = trace_by_sequence.get(sequence)
        action = str(fill.get("action") or fill.get("side") or "")
        decision_time = int((trace or {}).get("eventTimeMs") or 0)
        action_key = (decision_time, action)
        action_occurrences[action_key] += 1
        fill.update(
            {
                "fill_id": fill_id,
                "decision_sequence": sequence,
                "decision_id": None if trace is None else trace.get("decisionId"),
                "decision_time_ms": decision_time,
                "decision_trace_ordinal": (
                    None if trace is None else trace.get("decisionTraceOrdinal")
                ),
                "decision_ordinal_at_time": (
                    None if trace is None else trace.get("ordinalAtTime")
                ),
                "decision_action_ordinal": action_occurrences[action_key],
            }
        )
        fill["explanation"] = build_explanation(
            run_id=run_id,
            strategy_revision_id=revision_id,
            trace=trace,
            action=_action_kind(action),
            trade_id=None,
            order_id=order_id or None,
            fill_id=fill_id,
            execution_state="FILLED",
            execution_reason=str(fill.get("reason") or "") or None,
        )
        enriched_fills.append(fill)

    enriched_rejections: list[dict[str, object]] = []
    for index, raw in enumerate(rejections):
        rejection = copy.deepcopy(dict(raw))
        sequence = int(rejection.get("sequence") or 0)
        trace = trace_by_sequence.get(sequence)
        rejection_id = f"rejection-{sequence}-{index + 1}"
        rejection["rejection_id"] = rejection_id
        rejection["decision_id"] = None if trace is None else trace.get("decisionId")
        rejection["explanation"] = build_explanation(
            run_id=run_id,
            strategy_revision_id=revision_id,
            trace=trace,
            action="REJECT",
            trade_id=None,
            order_id=None,
            fill_id=None,
            execution_state="REJECTED",
            execution_reason=str(
                rejection.get("reason_code") or rejection.get("reason") or ""
            )
            or None,
        )
        enriched_rejections.append(rejection)
    return (
        enriched_fills,
        [copy.deepcopy(dict(item)) for item in orders],
        enriched_rejections,
    )


def trade_fingerprint(trade: Mapping[str, object], *, symbol: str) -> dict[str, object]:
    payload = {
        "fingerprint_version": TRADE_FINGERPRINT_SCHEMA,
        "symbol": symbol,
        "side": str(trade.get("side") or ""),
        "entry_decision_time": int(trade.get("entry_decision_time_ms") or 0),
        "entry_decision_ordinal_at_time": int(
            trade.get("entry_decision_ordinal_at_time") or 0
        ),
        "entry_action": str(trade.get("entry_action") or ""),
        "entry_action_ordinal": int(trade.get("entry_action_ordinal") or 0),
        "exit_decision_time": int(trade.get("exit_decision_time_ms") or 0),
        "exit_decision_ordinal_at_time": int(
            trade.get("exit_decision_ordinal_at_time") or 0
        ),
        "exit_action": str(trade.get("exit_action") or ""),
        "exit_action_ordinal": int(trade.get("exit_action_ordinal") or 0),
    }
    return {
        "version": TRADE_FINGERPRINT_SCHEMA,
        "hash": "sha256:" + jcs_sha256(payload),
    }


def fingerprint_multiset_diff(
    left: Sequence[Mapping[str, object]], right: Sequence[Mapping[str, object]]
) -> dict[str, object]:
    def counts(rows: Sequence[Mapping[str, object]]) -> Counter[str]:
        values: Counter[str] = Counter()
        for row in rows:
            fingerprint = row.get("trade_fingerprint")
            if (
                isinstance(fingerprint, Mapping)
                and fingerprint.get("version") == TRADE_FINGERPRINT_SCHEMA
                and isinstance(fingerprint.get("hash"), str)
                and str(fingerprint["hash"]).startswith("sha256:")
                and len(str(fingerprint["hash"])) == 71
            ):
                values[jcs_dumps(fingerprint)] += 1
        return values

    left_counts, right_counts = counts(left), counts(right)
    added = right_counts - left_counts
    removed = left_counts - right_counts
    return {
        "version": TRADE_FINGERPRINT_SCHEMA,
        "addedCount": sum(added.values()),
        "removedCount": sum(removed.values()),
        "unchangedCount": sum((left_counts & right_counts).values()),
        "added": [
            {"fingerprint": json.loads(value), "occurrences": count}
            for value, count in sorted(added.items())
        ],
        "removed": [
            {"fingerprint": json.loads(value), "occurrences": count}
            for value, count in sorted(removed.items())
        ],
    }


def build_comparison_context(
    *,
    run: Mapping[str, object],
    config: Mapping[str, object],
    provider_identity: Mapping[str, object] | None,
    revision: Mapping[str, object] | None,
) -> dict[str, object]:
    provider_identity = provider_identity or {}
    revision = revision or {}
    fidelity = str(run.get("fidelity_mode") or "")
    context: dict[str, object] = {
        "market": {
            "exchange": config.get("exchange") or "binance",
            "marketType": config.get("market_type") or "usdm",
            "symbol": config.get("symbol") or run.get("dataset_id"),
            "interval": config.get("signal_interval") or config.get("interval"),
        },
        "dataset": {
            "datasetId": run.get("dataset_id"),
            "dataEpoch": run.get("data_epoch"),
            "snapshotHash": run.get("snapshot_hash"),
        },
        "range": {
            "startTimeMs": config.get("start_time_ms"),
            "endTimeMs": config.get("end_time_ms"),
            "rangeMode": config.get("chart_range_mode") or "CUSTOM",
        },
        "fidelity": fidelity,
        "account": {
            "model": config.get("account_model")
            or run.get("account_model")
            or "LINEAR_PERP_ONE_WAY_V1",
            "initialBalance": config.get("initial_balance"),
            "sizingPolicy": config.get("sizing_policy") or "FIXED_QTY_V1",
            "fixedQty": config.get("fixed_qty") or "1",
            "fixedNotional": config.get("fixed_notional"),
            "equityPercent": config.get("equity_percent"),
            "leverage": config.get("leverage") or "1",
        },
        "costExecution": {
            key: (
                config.get(key)
                if key
                not in {"fee_source", "funding_mode", "latency_ms", "latency_events"}
                else config.get(key)
                or {
                    "fee_source": "EXPLICIT_RATES_V1",
                    "funding_mode": "OFF",
                    "latency_ms": 0,
                    "latency_events": 0,
                }[key]
            )
            for key in (
                "fee_source",
                "taker_fee_bps",
                "maker_fee_bps",
                "funding_rate",
                "funding_interval_hours",
                "funding_mode",
                "slippage_bps",
                "latency_ms",
                "latency_events",
                "execution_model_revision",
                "fill_policy",
                "bar_path_scenario",
                "order_end_policy",
                "participation_rate",
                "gap_policy",
                "signal_clock",
                "execution_clock",
                "price_tick",
                "qty_step",
                "min_notional",
            )
        },
        "metricsVersion": config.get("metrics_version") or "BACKTEST_METRICS_LEGACY_V1",
        "runtime": {
            "providerProtocol": PROTOCOL,
            "providerRevision": config.get("strategy_execution_revision"),
            "providerIdentity": dict(provider_identity),
            "compilerRevision": revision.get("compiler_revision")
            or revision.get("base_revision_id"),
            "runtimeRevision": revision.get("runtime_revision"),
            "languageAbi": revision.get("language") or revision.get("provider_kind"),
            "hostAdapterRevision": config.get("host_policy_revision")
            or "PYNE_HOST_ADAPTER_V1",
        },
        "randomness": {
            "seed": config.get("seed", 0),
            "rngPolicy": config.get("rng_policy") or "NO_RANDOMNESS_V1",
        },
        "builderRevision": config.get("bar_builder")
        or ("BAR_INPUT_ORDER_V1" if fidelity == "BAR_APPROX" else None),
    }
    required_paths = {
        "market.exchange": context["market"]["exchange"],  # type: ignore[index]
        "market.marketType": context["market"]["marketType"],  # type: ignore[index]
        "market.symbol": context["market"]["symbol"],  # type: ignore[index]
        "market.interval": context["market"]["interval"],  # type: ignore[index]
        "dataset.datasetId": context["dataset"]["datasetId"],  # type: ignore[index]
        "dataset.dataEpoch": context["dataset"]["dataEpoch"],  # type: ignore[index]
        "dataset.snapshotHash": context["dataset"]["snapshotHash"],  # type: ignore[index]
        "range.startTimeMs": context["range"]["startTimeMs"],  # type: ignore[index]
        "range.endTimeMs": context["range"]["endTimeMs"],  # type: ignore[index]
        "fidelity": context["fidelity"],
        "account.model": context["account"]["model"],  # type: ignore[index]
        "account.initialBalance": context["account"]["initialBalance"],  # type: ignore[index]
        "runtime.providerRevision": context["runtime"]["providerRevision"],  # type: ignore[index]
        "runtime.compilerRevision": context["runtime"]["compilerRevision"],  # type: ignore[index]
        "runtime.runtimeRevision": context["runtime"]["runtimeRevision"],  # type: ignore[index]
        "runtime.languageAbi": context["runtime"]["languageAbi"],  # type: ignore[index]
        "builderRevision": context["builderRevision"],
    }
    missing_fields = sorted(
        path for path, value in required_paths.items() if value is None or value == ""
    )
    return {
        "schema": "COMPARISON_CONTEXT_V1",
        "canonicalization": CANONICALIZATION,
        "context": context,
        "contextHash": jcs_sha256(context),
        "complete": not missing_fields,
        "missingFields": missing_fields,
    }
