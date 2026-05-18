"""Pyne input and output schema helpers."""
from __future__ import annotations

from typing import Any


PYNE_INPUT_SCHEMA_VERSION = 1
PYNE_OUTPUT_SCHEMA_VERSION = 1

OHLCV_FIELDS = ("time", "open", "high", "low", "close", "volume")
OUTPUT_KEYS = (
    "lines",
    "histograms",
    "markers",
    "hlines",
    "fills",
    "bgcolors",
    "barcolors",
    "signals",
)


def input_schema() -> dict[str, Any]:
    """Return the stable Pyne OHLCV input contract."""
    return {
        "schemaVersion": PYNE_INPUT_SCHEMA_VERSION,
        "type": "ohlcv",
        "required": list(OHLCV_FIELDS),
        "timeUnit": "seconds",
        "bar": {
            "time": "Unix timestamp in seconds",
            "open": "Open price as float",
            "high": "High price as float",
            "low": "Low price as float",
            "close": "Close price as float",
            "volume": "Volume as float",
        },
    }


def output_schema() -> dict[str, Any]:
    """Return the stable Pyne result/output contract."""
    return {
        "schemaVersion": PYNE_OUTPUT_SCHEMA_VERSION,
        "result": {
            "ok": "Whether execution succeeded",
            "error": "Error message when execution failed",
            "code": "Stable error code when execution failed",
            "errorDetail": "Structured error detail when execution failed",
            "lines": "Backward-compatible flat plotted series",
            "output": "Structured output collections",
            "param_schema": "Input parameter declarations collected from scripts",
            "meta": "Indicator metadata collected from indicator()",
        },
        "outputKeys": list(OUTPUT_KEYS),
        "point": {
            "time": "Unix timestamp in seconds",
            "value": "Numeric point value",
        },
        "paneValues": ["main", "separate"],
    }


def schema() -> dict[str, Any]:
    """Return the public Pyne input/output schema bundle."""
    return {
        "input": input_schema(),
        "output": output_schema(),
    }

