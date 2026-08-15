"""CandleScope Python strategy author SDK. No Host, network, or database client."""

from .contract import (
    AUTHOR_CONTRACT,
    BUNDLE_SCHEMA,
    PROVIDER_PROTOCOL,
    RUNTIME_PROFILE,
    WIRE_TRANSPORT,
)
from .errors import PythonStrategyContractError
from .json_codec import canonical_sha256, dumps_canonical, loads_strict
from .models import (
    Bar,
    ExecutionReport,
    Observation,
    OrderIntent,
    Signal,
    StrategyContext,
    TargetPosition,
    encode_output,
    encode_snapshot,
)

__version__ = "0.1.0"
__all__ = [
    "AUTHOR_CONTRACT",
    "BUNDLE_SCHEMA",
    "PROVIDER_PROTOCOL",
    "RUNTIME_PROFILE",
    "WIRE_TRANSPORT",
    "Bar",
    "ExecutionReport",
    "Observation",
    "OrderIntent",
    "PythonStrategyContractError",
    "Signal",
    "StrategyContext",
    "TargetPosition",
    "canonical_sha256",
    "dumps_canonical",
    "encode_output",
    "encode_snapshot",
    "loads_strict",
    "__version__",
]
