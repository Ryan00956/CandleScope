"""Dataset-bound, one-shot builtin indicators for local analysis mode."""

from __future__ import annotations

import math
import os
import re
from typing import Any

from app.data_engine.data_manager.models import BarData
from app.indicator import create_engine, registry


MAX_LOCAL_INDICATOR_BARS = int(
    os.getenv("CANDLESCOPE_LOCAL_INDICATOR_MAX_BARS", "250000")
)
if MAX_LOCAL_INDICATOR_BARS < 1:
    raise ValueError("CANDLESCOPE_LOCAL_INDICATOR_MAX_BARS must be positive")
# The shared registry is the catalog truth. Dataset capabilities, rather than
# a second product list, decide whether a registered builtin can execute.
LOCAL_INDICATOR_NAMES = frozenset(spec.name for spec in registry.list_specs())
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _invalid_params(message: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "ok": False,
        "code": "LOCAL_INDICATOR_PARAMS_INVALID",
        "error": message,
        "errorDetail": {
            "message": message,
            "hint": "请按本地指标面板给出的范围修改参数。",
        },
        "lines": [],
    }


def _serialize_result(result: Any) -> dict[str, Any]:
    if result is None:
        return {
            "schemaVersion": 1,
            "ok": False,
            "code": "LOCAL_INDICATOR_RESULT_EMPTY",
            "error": "Indicator computation returned no result",
            "lines": [],
        }
    if result.error:
        return {
            "schemaVersion": 1,
            "ok": False,
            "code": "LOCAL_INDICATOR_COMPUTE_FAILED",
            "error": result.error,
            "lines": [],
            "result": result.to_dict(),
        }
    return {
        "schemaVersion": 1,
        "ok": True,
        "error": None,
        "lines": result.lines,
        "result": result.to_dict(),
    }


def _normalize_params(
    name: str,
    supplied: dict[str, Any],
    *,
    volume_available: bool,
) -> dict[str, Any]:
    spec = registry.get_spec(name)
    if spec is None or name not in LOCAL_INDICATOR_NAMES:
        raise ValueError(f"Indicator '{name}' is not available in local analysis mode")
    if name == "VOL" and not volume_available:
        raise ValueError("VOL requires an imported volume column")
    schema_by_key = {parameter.key: parameter for parameter in spec.param_schema}
    unknown = sorted(set(supplied) - set(schema_by_key))
    if unknown:
        raise ValueError(f"Unsupported {name} parameters: {', '.join(unknown)}")
    normalized = dict(spec.default_params)
    normalized.update(supplied)
    for key, parameter in schema_by_key.items():
        value = normalized.get(key, parameter.default)
        if parameter.type == "int":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name}.{key} must be an integer")
            numeric = float(value)
            if not math.isfinite(numeric) or not numeric.is_integer():
                raise ValueError(f"{name}.{key} must be an integer")
            value = int(numeric)
        elif parameter.type == "float":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name}.{key} must be a number")
            value = float(value)
            if not math.isfinite(value):
                raise ValueError(f"{name}.{key} must be finite")
        elif parameter.type == "bool":
            if not isinstance(value, bool):
                raise ValueError(f"{name}.{key} must be true or false")
        elif parameter.type == "color":
            if not isinstance(value, str) or _COLOR_RE.fullmatch(value) is None:
                raise ValueError(f"{name}.{key} must be a #RRGGBB color")
        elif parameter.type == "string":
            if not isinstance(value, str):
                raise ValueError(f"{name}.{key} must be text")
        if parameter.min is not None and isinstance(value, (int, float)):
            if value < parameter.min:
                raise ValueError(f"{name}.{key} must be at least {parameter.min:g}")
        if parameter.max is not None and isinstance(value, (int, float)):
            if value > parameter.max:
                raise ValueError(f"{name}.{key} must be at most {parameter.max:g}")
        if parameter.options is not None and value not in parameter.options:
            raise ValueError(
                f"{name}.{key} must be one of {', '.join(parameter.options)}"
            )
        normalized[key] = value
    if name == "MACD" and normalized["fast"] >= normalized["slow"]:
        raise ValueError("MACD.fast must be less than MACD.slow")
    return normalized


def _bars_from_rows(rows: list[dict[str, Any]]) -> list[BarData]:
    bars: list[BarData] = []
    for row in rows:
        # BarData requires a volume float. Missing volume gets an internal
        # placeholder, while capability checks keep volume-dependent builtins
        # unavailable and the dataset API continues to expose volume as null.
        volume = row.get("volume")
        bars.append(
            BarData(
                time=int(row["time"]),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=0.0 if volume is None else float(volume),
                is_closed=bool(row.get("is_closed", True)),
                source="local_dataset",
            )
        )
    return bars


def compute_local_indicator_batch(
    *,
    dataset_id: str,
    data_epoch: str,
    symbol: str,
    interval: str,
    volume_available: bool,
    rows: list[dict[str, Any]],
    requests: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compute requested builtins over all imported rows without runtime services."""
    if not rows:
        raise ValueError("Local dataset contains no bars")
    bars = _bars_from_rows(rows)
    engine = create_engine()
    results: list[dict[str, Any]] = []
    try:
        for item in requests:
            name = str(item["name"]).upper()
            spec = registry.get_spec(name)
            try:
                params = _normalize_params(
                    name,
                    dict(item.get("params") or {}),
                    volume_available=volume_available,
                )
                result = engine.compute(
                    symbol=symbol,
                    interval=interval,
                    market_type=dataset_id,
                    indicator_name=name,
                    params=params,
                    bars=bars,
                    exchange="local",
                )
                payload = _serialize_result(result)
            except (TypeError, ValueError) as exc:
                payload = _invalid_params(str(exc))
            if spec is not None:
                payload["param_schema"] = [
                    parameter.to_dict() for parameter in spec.param_schema
                ]
            payload.update(
                {
                    "source": "local_dataset",
                    "complete": True,
                    "retryable": False,
                    "terminal_reason": "dataset_boundary",
                    "dataRevision": {"token": data_epoch},
                }
            )
            results.append(
                {
                    "jobKey": item["jobKey"],
                    "clientId": item["clientId"],
                    "payload": payload,
                }
            )
    finally:
        engine.stop()
    return {
        "schemaVersion": 1,
        "type": "local.indicator.compute_batch",
        "source": "local_dataset",
        "dataset_id": dataset_id,
        "data_epoch": data_epoch,
        "ok": all(item["payload"].get("ok") is True for item in results),
        "results": results,
    }
