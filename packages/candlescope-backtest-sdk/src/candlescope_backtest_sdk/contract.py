"""Frozen names for candlescope.python-strategy/1."""

from __future__ import annotations

AUTHOR_CONTRACT = "candlescope.python-strategy/1"
PROVIDER_PROTOCOL = "strategy-provider/1"
BUNDLE_SCHEMA = "candlescope.python-strategy-bundle/1"
RUNTIME_PROFILE = "python-strategy-runtime/1"
WIRE_TRANSPORT = "strict-jsonl/1"
OBSERVATION_SCHEMA = "candlescope.python-strategy-observation/1"
OUTPUT_SCHEMA = "candlescope.python-strategy-output/1"
CONTEXT_SCHEMA = "candlescope.python-strategy-context/1"
EXECUTION_REPORT_SCHEMA = "candlescope.python-strategy-execution-report/1"

SIGNAL_CLOCKS = frozenset({"BAR_CLOSE"})
OUTPUT_KINDS = frozenset({"SIGNAL", "TARGET_POSITION", "ORDER_INTENT"})
SIGNAL_DIRECTIONS = frozenset({"LONG", "SHORT", "FLAT"})
ORDER_SIDES = frozenset({"BUY", "SELL"})
ORDER_TYPES = frozenset({"MARKET", "LIMIT", "STOP", "STOP_LIMIT"})
TIME_IN_FORCE = frozenset({"GTC", "IOC", "FOK"})
REPRODUCIBILITY_CLASSES = frozenset(
    {
        "DETERMINISTIC_CPU_LOCKED",
        "SEEDED_CPU_LOCKED",
        "BEST_EFFORT_LOCAL",
        "RECORDED_OUTPUT_ONLY",
    }
)
LIFECYCLE = (
    "prepare",
    "warmup",
    "step",
    "on_execution_report",
    "snapshot",
    "restore",
    "close",
)
MAX_SAFE_INTEGER = 9_007_199_254_740_991
DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024
DEFAULT_MAX_CONTAINER_ITEMS = 10_000
DEFAULT_MAX_STRING_BYTES = 64 * 1024
DEFAULT_MAX_JSON_DEPTH = 16
