"""Replay-isolated aggregate-trade tape and order-flow projection."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, InvalidOperation

from app.replay.canonical import canonical_sha256

from .errors import TrainingRunError


REPLAY_TRADE_FLOW_SCHEMA_VERSION = "replay.trade-flow.v1"
REPLAY_TRADE_FLOW_FIDELITY = "AGGREGATE_TRADE_NOT_RAW_TRADE"


def _counter(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TrainingRunError(
            "REPLAY_TRADE_FLOW_DEGRADED",
            f"{field_name} is invalid",
            status_code=409,
        )
    return value


def _decimal(value: object, field_name: str) -> Decimal:
    if not isinstance(value, str):
        raise TrainingRunError(
            "REPLAY_TRADE_FLOW_DEGRADED",
            f"{field_name} is invalid",
            status_code=409,
        )
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise TrainingRunError(
            "REPLAY_TRADE_FLOW_DEGRADED",
            f"{field_name} is invalid",
            status_code=409,
        ) from exc
    if not number.is_finite() or number <= 0:
        raise TrainingRunError(
            "REPLAY_TRADE_FLOW_DEGRADED",
            f"{field_name} must be positive and finite",
            status_code=409,
        )
    return number


def _decimal_string(value: Decimal) -> str:
    normalized = format(value, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


class ReplayTradeFlowAdapter:
    """Validate one source page and project tape plus page-local CVD deltas."""

    def project(
        self,
        *,
        run_id: str,
        track_id: str,
        source_page: Mapping[str, object],
    ) -> dict[str, object]:
        if not isinstance(source_page, Mapping):
            raise TypeError("source_page must be an object")
        after_sequence = _counter(source_page.get("after_sequence"), "after_sequence")
        next_sequence = _counter(source_page.get("next_sequence"), "next_sequence")
        revealed_sequence = _counter(
            source_page.get("revealed_sequence"), "revealed_sequence"
        )
        data_epoch = source_page.get("data_epoch")
        events = source_page.get("events")
        streaming = source_page.get("streaming")
        if (
            not isinstance(data_epoch, str)
            or not data_epoch
            or not isinstance(events, list)
            or not isinstance(source_page.get("has_more"), bool)
            or not isinstance(streaming, Mapping)
        ):
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_DEGRADED",
                "aggregate-trade page envelope is invalid",
                status_code=409,
            )
        if not after_sequence <= next_sequence <= revealed_sequence:
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_DEGRADED",
                "aggregate-trade page sequence moved backward",
                status_code=409,
            )
        tape: list[dict[str, object]] = []
        buy_quantity = Decimal(0)
        sell_quantity = Decimal(0)
        quote_quantity = Decimal(0)
        previous_id: int | None = None
        previous_time: int | None = None
        for index, raw in enumerate(events):
            if not isinstance(raw, Mapping):
                raise TrainingRunError(
                    "REPLAY_TRADE_FLOW_DEGRADED",
                    "aggregate-trade tape item is invalid",
                    status_code=409,
                )
            sequence = _counter(raw.get("source_sequence"), "source_sequence")
            agg_trade_id = _counter(raw.get("agg_trade_id"), "agg_trade_id")
            first_trade_id = _counter(raw.get("first_trade_id"), "first_trade_id")
            last_trade_id = _counter(raw.get("last_trade_id"), "last_trade_id")
            trade_time_ms = _counter(raw.get("trade_time_ms"), "trade_time_ms")
            expected_sequence = after_sequence + index + 1
            if sequence != expected_sequence:
                raise TrainingRunError(
                    "REPLAY_TRADE_FLOW_RESYNC_REQUIRED",
                    "aggregate-trade source sequence is discontinuous",
                    status_code=409,
                    details={"expected": expected_sequence, "actual": sequence},
                )
            if previous_id is not None and agg_trade_id != previous_id + 1:
                raise TrainingRunError(
                    "REPLAY_TRADE_FLOW_RESYNC_REQUIRED",
                    "aggregate-trade ID continuity was lost",
                    status_code=409,
                )
            if previous_time is not None and trade_time_ms < previous_time:
                raise TrainingRunError(
                    "REPLAY_TRADE_FLOW_RESYNC_REQUIRED",
                    "aggregate-trade time order was lost",
                    status_code=409,
                )
            if last_trade_id < first_trade_id:
                raise TrainingRunError(
                    "REPLAY_TRADE_FLOW_DEGRADED",
                    "aggregate-trade raw trade bounds are invalid",
                    status_code=409,
                )
            price = _decimal(raw.get("price"), "price")
            quantity = _decimal(raw.get("quantity"), "quantity")
            quote = _decimal(raw.get("quote_quantity"), "quote_quantity")
            is_buyer_maker = raw.get("is_buyer_maker")
            if not isinstance(is_buyer_maker, bool):
                raise TrainingRunError(
                    "REPLAY_TRADE_FLOW_DEGRADED",
                    "aggregate-trade maker side is invalid",
                    status_code=409,
                )
            aggressor_side = "SELL" if is_buyer_maker else "BUY"
            delta = -quantity if is_buyer_maker else quantity
            if is_buyer_maker:
                sell_quantity += quantity
            else:
                buy_quantity += quantity
            quote_quantity += quote
            tape.append(
                {
                    "source_sequence": sequence,
                    "agg_trade_id": agg_trade_id,
                    "trade_time_ms": trade_time_ms,
                    "price": _decimal_string(price),
                    "quantity": _decimal_string(quantity),
                    "quote_quantity": _decimal_string(quote),
                    "raw_trade_count": last_trade_id - first_trade_id + 1,
                    "aggressor_side": aggressor_side,
                    "cvd_delta": _decimal_string(delta),
                    "fidelity": REPLAY_TRADE_FLOW_FIDELITY,
                }
            )
            previous_id = agg_trade_id
            previous_time = trade_time_ms
        if next_sequence != after_sequence + len(tape):
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_RESYNC_REQUIRED",
                "aggregate-trade page cursor does not match its items",
                status_code=409,
            )
        has_more = bool(source_page["has_more"])
        if has_more != (next_sequence < revealed_sequence):
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_RESYNC_REQUIRED",
                "aggregate-trade page continuation marker is inconsistent",
                status_code=409,
            )
        delta = buy_quantity - sell_quantity
        cursor = {
            "source_sequence": next_sequence,
            "data_epoch": data_epoch,
        }
        return {
            "protocol": "replay.v2",
            "schema_version": REPLAY_TRADE_FLOW_SCHEMA_VERSION,
            "run_id": run_id,
            "track_id": track_id,
            "source_kind": "AGG_TRADE",
            "capabilities": {
                "tape": "AVAILABLE_EXACT",
                "order_flow": "AVAILABLE_APPROX",
            },
            "fidelity": REPLAY_TRADE_FLOW_FIDELITY,
            "continuity": {
                "state": "CONTIGUOUS",
                "data_epoch": data_epoch,
                "after_sequence": after_sequence,
                "next_sequence": next_sequence,
                "revealed_sequence": revealed_sequence,
                "resync_token": canonical_sha256(
                    {
                        "run_id": run_id,
                        "track_id": track_id,
                        **cursor,
                    }
                ),
            },
            "tape": tape,
            "page_flow": {
                "buy_quantity": _decimal_string(buy_quantity),
                "sell_quantity": _decimal_string(sell_quantity),
                "delta": _decimal_string(delta),
                "quote_quantity": _decimal_string(quote_quantity),
                "trade_count": len(tape),
                "cvd_contract": "CLIENT_PREFIX_SUM_OF_CONTIGUOUS_PAGE_DELTAS",
            },
            "next_cursor": cursor,
            "has_more": has_more,
            "streaming": dict(streaming),
        }


__all__ = [
    "REPLAY_TRADE_FLOW_FIDELITY",
    "REPLAY_TRADE_FLOW_SCHEMA_VERSION",
    "ReplayTradeFlowAdapter",
]
