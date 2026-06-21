from __future__ import annotations

from typing import get_type_hints, is_typeddict

import pyne_runtime as pn
from pyne_runtime.request import OHLCVBar, RequestMetadata


def test_request_provider_typing_exports_are_public() -> None:
    assert pn.OHLCVBar is OHLCVBar
    assert pn.RequestMetadata is RequestMetadata
    assert pn.REQUEST_SECURITY_API == "request.security"
    assert pn.REQUEST_SECURITY_LOWER_TF_API == "request.security_lower_tf"
    assert pn.REQUEST_API_VALUES == (
        pn.REQUEST_SECURITY_API,
        pn.REQUEST_SECURITY_LOWER_TF_API,
    )
    assert pn.REQUEST_SECURITY_CAPABILITY_ALIASES == (
        pn.REQUEST_SECURITY_API,
        "security",
        "ohlcv",
    )
    assert pn.REQUEST_SECURITY_LOWER_TF_CAPABILITY_ALIASES == (
        pn.REQUEST_SECURITY_LOWER_TF_API,
        "security_lower_tf",
        "lower_tf",
    )
    assert pn.REQUEST_METADATA_SYMBOL_KEYS == ("syminfo", "symbol_info")
    assert pn.REQUEST_METADATA_TIMEFRAME_KEYS == ("timeframe", "timeframe_info")
    assert pn.REQUEST_METADATA_SESSION_KEYS == ("session", "session_info")
    assert pn.REQUEST_METADATA_KEY_ALIASES == {
        "syminfo": pn.REQUEST_METADATA_SYMBOL_KEYS,
        "timeframe": pn.REQUEST_METADATA_TIMEFRAME_KEYS,
        "session": pn.REQUEST_METADATA_SESSION_KEYS,
    }
    assert hasattr(pn, "RequestCapabilities")
    assert hasattr(pn, "RequestCapabilityProvider")
    assert hasattr(pn, "RequestMetadataProvider")


def test_request_provider_typed_dict_contracts_are_discoverable() -> None:
    assert is_typeddict(OHLCVBar)
    assert OHLCVBar.__required_keys__ == {
        "time",
        "open",
        "high",
        "low",
        "close",
        "volume",
    }
    assert "time_close" in OHLCVBar.__optional_keys__

    assert is_typeddict(RequestMetadata)
    assert "syminfo" in RequestMetadata.__optional_keys__
    assert "timeframe_info" in RequestMetadata.__optional_keys__
    assert "session_info" in RequestMetadata.__optional_keys__


def test_data_provider_protocol_uses_ohlcv_bar_type() -> None:
    hints = get_type_hints(pn.DataProvider.get_ohlcv)

    assert hints["symbol"] is str
    assert hints["timeframe"] is str
    assert hints["start"] is int
    assert hints["end"] is int
    assert hints["return"] == list[OHLCVBar]
