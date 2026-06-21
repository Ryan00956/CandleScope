"""Provider protocol and metadata helpers for host-backed requests."""
from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any, Protocol, TypeAlias, TypedDict

from .errors import PyneRequestError
from .. import _request_contract
from ..metadata import SessionInfo, SymbolInfo, TimeframeInfo

REQUEST_SECURITY_API = _request_contract.REQUEST_SECURITY_API
REQUEST_SECURITY_LOWER_TF_API = _request_contract.REQUEST_SECURITY_LOWER_TF_API
REQUEST_API_VALUES = _request_contract.REQUEST_API_VALUES
REQUEST_SECURITY_CAPABILITY_ALIASES = (
    _request_contract.REQUEST_SECURITY_CAPABILITY_ALIASES
)
REQUEST_SECURITY_LOWER_TF_CAPABILITY_ALIASES = (
    _request_contract.REQUEST_SECURITY_LOWER_TF_CAPABILITY_ALIASES
)
REQUEST_METADATA_SYMBOL_KEYS = _request_contract.REQUEST_METADATA_SYMBOL_KEYS
REQUEST_METADATA_TIMEFRAME_KEYS = _request_contract.REQUEST_METADATA_TIMEFRAME_KEYS
REQUEST_METADATA_SESSION_KEYS = _request_contract.REQUEST_METADATA_SESSION_KEYS
REQUEST_METADATA_KEY_ALIASES = _request_contract.REQUEST_METADATA_KEY_ALIASES
_MISSING = object()


class _RequiredOHLCVBar(TypedDict):
    time: int
    open: int | float
    high: int | float
    low: int | float
    close: int | float
    volume: int | float


class OHLCVBar(_RequiredOHLCVBar, total=False):
    """OHLCV row returned by host data providers."""

    time_close: int
    session: Mapping[str, bool]
    session_ismarket: bool
    session_isfirstbar: bool
    session_islastbar: bool


RequestCapabilities: TypeAlias = Mapping[str, bool] | Collection[str] | None
RequestSymbolMetadata: TypeAlias = SymbolInfo | Mapping[str, Any] | str | None
RequestTimeframeMetadata: TypeAlias = TimeframeInfo | Mapping[str, Any] | str | None
RequestSessionMetadata: TypeAlias = SessionInfo | Mapping[str, Any] | bool | None


class RequestMetadata(TypedDict, total=False):
    """Optional requested-context metadata supplied by host providers."""

    syminfo: RequestSymbolMetadata
    symbol_info: RequestSymbolMetadata
    timeframe: RequestTimeframeMetadata
    timeframe_info: RequestTimeframeMetadata
    session: RequestSessionMetadata
    session_info: RequestSessionMetadata


class DataProvider(Protocol):
    """Host interface used by ``request.security()``.

    Pyne defines alignment semantics, but the host owns market data retrieval.
    """

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[OHLCVBar]:
        """Return OHLCV bars for ``symbol`` and ``timeframe`` in ``[start, end]``."""


class RequestCapabilityProvider(Protocol):
    """Optional provider mixin for method-based capability declarations."""

    def capabilities(self) -> RequestCapabilities:
        """Return supported request capability aliases."""


class RequestMetadataProvider(Protocol):
    """Optional provider mixin for method-based requested-context metadata."""

    def get_request_metadata(self, symbol: str, timeframe: str) -> RequestMetadata:
        """Return metadata for a requested symbol/timeframe context."""


def _provider_supports(provider: DataProvider, capability_names: tuple[str, ...]) -> bool:
    try:
        declared_capabilities = getattr(provider, "capabilities", _MISSING)
        if callable(declared_capabilities):
            declared_capabilities = declared_capabilities()
    except PyneRequestError:
        raise
    except Exception as exc:
        raise PyneRequestError(
            f"request capability provider failed: {exc}",
            code="PYNE_RUNTIME_ERROR",
            category="capabilityFailure",
        ) from exc
    if declared_capabilities is _MISSING:
        return True
    if declared_capabilities is None:
        return False
    if isinstance(declared_capabilities, dict):
        matched_capabilities = [
            declared_capabilities[capability]
            for capability in capability_names
            if capability in declared_capabilities
        ]
        return any(bool(value) for value in matched_capabilities)
    if isinstance(declared_capabilities, (set, list, tuple)):
        declared = set(declared_capabilities)
        return any(capability in declared for capability in capability_names)
    return bool(declared_capabilities)

def _request_metadata(provider: DataProvider, symbol: str, timeframe: str) -> dict[str, Any]:
    declared_metadata = getattr(provider, "get_request_metadata", None)
    if callable(declared_metadata):
        try:
            declared_metadata = declared_metadata(symbol, timeframe)
        except PyneRequestError:
            raise
        except Exception as exc:
            raise PyneRequestError(
                f"request metadata provider failed: {exc}",
                code="PYNE_RUNTIME_ERROR",
                category="metadataFailure",
            ) from exc
    else:
        declared_metadata = getattr(provider, "request_metadata", None)
        if callable(declared_metadata):
            try:
                declared_metadata = declared_metadata(symbol, timeframe)
            except PyneRequestError:
                raise
            except Exception as exc:
                raise PyneRequestError(
                    f"request metadata provider failed: {exc}",
                    code="PYNE_RUNTIME_ERROR",
                    category="metadataFailure",
                ) from exc

    if declared_metadata is None:
        declared_metadata = {}
    if not isinstance(declared_metadata, Mapping):
        raise PyneRequestError(
            "request metadata must be a mapping with optional syminfo, timeframe, and session keys",
            code="PYNE_RUNTIME_ERROR",
            category="invalidMetadata",
        )

    syminfo = _metadata_value(declared_metadata, REQUEST_METADATA_SYMBOL_KEYS)
    timeframe_info = _metadata_value(
        declared_metadata,
        REQUEST_METADATA_TIMEFRAME_KEYS,
        default=timeframe,
    )
    session = _metadata_value(declared_metadata, REQUEST_METADATA_SESSION_KEYS)
    return {
        "syminfo": _symbol_metadata_with_defaults(symbol, syminfo),
        "timeframe": timeframe_info,
        "session": session,
    }

def _default_request_metadata(symbol: str, timeframe: str) -> dict[str, Any]:
    return {
        "syminfo": _symbol_metadata_with_defaults(symbol, None),
        "timeframe": timeframe,
        "session": None,
    }

def _symbol_metadata_with_defaults(symbol: str, syminfo: Any) -> Any:
    defaults = {"tickerid": symbol, "ticker": symbol}
    if syminfo is None:
        return defaults
    if isinstance(syminfo, Mapping):
        return {**defaults, **syminfo}
    return syminfo

def _metadata_value(
    metadata: Mapping[str, Any],
    keys: tuple[str, ...],
    *,
    default: Any = None,
) -> Any:
    for key in keys:
        if key in metadata:
            return metadata[key]
    return default
