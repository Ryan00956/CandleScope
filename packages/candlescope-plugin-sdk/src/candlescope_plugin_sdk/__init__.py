"""Public API for CandleScope script runtime plugin authors."""

from .constants import (
    DEFAULT_MAX_MESSAGE_BYTES,
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_SOURCE_ANALYSIS_V1,
    JSONRPC_VERSION,
    KNOWN_FEATURES_V1,
    PROTOCOL_V1,
    RENDER_IR_V1,
    REQUIRED_METHODS,
)
from .errors import ProtocolError
from .models import (
    AnalyzeRequest,
    AnalyzeResult,
    Bar,
    Diagnostic,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    HandshakeRequest,
    HandshakeResult,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    MarketContext,
    RenderOutput,
    RuntimeDescriptor,
)
from .runtime import BaseRuntimePlugin, RuntimeDispatcher
from .server import JsonLineRuntimeServer, serve_runtime


__version__ = "0.1.0"

__all__ = [
    "AnalyzeRequest",
    "AnalyzeResult",
    "Bar",
    "BaseRuntimePlugin",
    "DEFAULT_MAX_MESSAGE_BYTES",
    "Diagnostic",
    "ExecuteBatchRequest",
    "ExecuteBatchResult",
    "FEATURE_BATCH_EXECUTION_V1",
    "FEATURE_RENDER_LINE_SERIES_V1",
    "FEATURE_SOURCE_ANALYSIS_V1",
    "HandshakeRequest",
    "HandshakeResult",
    "JSONRPC_VERSION",
    "JsonLineRuntimeServer",
    "KNOWN_FEATURES_V1",
    "LanguageDescriptor",
    "LinePoint",
    "LineSeries",
    "MarketContext",
    "PROTOCOL_V1",
    "ProtocolError",
    "RENDER_IR_V1",
    "REQUIRED_METHODS",
    "RenderOutput",
    "RuntimeDescriptor",
    "RuntimeDispatcher",
    "serve_runtime",
]
