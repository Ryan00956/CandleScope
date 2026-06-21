from __future__ import annotations

from typing import Any

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
        {"time": 4, "open": 4, "high": 5, "low": 3.5, "close": 4.5, "volume": 160},
    ]


class StaticProvider:
    def __init__(self, bars: list[dict[str, Any]]) -> None:
        self.calls: list[tuple[str, str, int, int]] = []
        self._bars = bars

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[dict[str, Any]]:
        self.calls.append((symbol, timeframe, start, end))
        return self._bars


class CapabilityProvider(StaticProvider):
    def __init__(self, bars: list[dict[str, Any]], capabilities: Any) -> None:
        super().__init__(bars)
        self.capabilities = capabilities


class InvalidSymbolProvider(StaticProvider):
    def __init__(self) -> None:
        super().__init__([])

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[dict[str, Any]]:
        self.calls.append((symbol, timeframe, start, end))
        raise pn.PyneInvalidSymbolError(symbol)


def test_request_security_aligns_host_data_to_chart_bars() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert result.values("Higher") == [10, 10, 30]


def test_request_security_applies_history_in_requested_context() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF History", overlay=True)
higher_prev = request.security("BTCUSDT", "2", close[1])
plot(higher_prev, "Higher Previous")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Higher Previous") == [10]


def test_request_security_gaps_on_requires_exact_requested_bar() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Gaps", overlay=True)
higher = request.security("BTCUSDT", "2", "close", gaps="on")
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.get_series("Higher") == [
        {"time": 2, "value": 10.0},
        {"time": 4, "value": 30.0},
    ]


def test_request_security_rejects_invalid_history_offset_expression() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Bad History", overlay=True)
higher = request.security("BTCUSDT", "2", "close[bad]")
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "history offset" in str(result.error)


def test_request_security_accepts_barmerge_alignment_constants() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Barmerge", overlay=True)
gapped = request.security("BTCUSDT", "2", "close", gaps=barmerge.gaps_on)
ahead = request.security("BTCUSDT", "2", "close", lookahead=barmerge.lookahead_on)
plot(gapped, "Gapped")
plot(ahead, "Ahead")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert result.get_series("Gapped") == [
        {"time": 2, "value": 10.0},
        {"time": 4, "value": 30.0},
    ]
    assert result.values("Ahead") == [10, 10, 30, 30]


def test_request_security_rejects_invalid_gaps_before_provider_call() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Invalid Gaps", overlay=True)
higher = request.security("BTCUSDT", "2", "close", gaps="maybe")
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "gaps must be one of" in str(result.error)
    assert provider.calls == []


def test_request_security_rejects_invalid_lookahead_before_provider_call() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Invalid Lookahead", overlay=True)
higher = request.security("BTCUSDT", "2", "close", lookahead="future")
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "lookahead must be one of" in str(result.error)
    assert provider.calls == []


def test_request_security_requires_host_provider() -> None:
    result = pn.run(
        """
indicator("Missing Provider", overlay=True)
plot(request.security("BTCUSDT", "1h", close), "Higher")
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "host data provider" in str(result.error)


def test_request_security_reports_invalid_symbol_by_default() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Invalid Symbol", overlay=True)
higher = request.security("MISSING", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_SYMBOL"
    assert "MISSING" in str(result.error)
    assert provider.calls == [("MISSING", "2", 1, 4)]


def test_request_security_ignore_invalid_symbol_returns_na() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Ignored Invalid Symbol", overlay=True)
higher = request.security("MISSING", "2", close, ignore_invalid_symbol=True)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "2", 1, 4)]
    assert result.get_series("Higher") == []
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "MISSING",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": True,
            "status": "ignoredInvalidSymbol",
        },
    ]


def test_request_security_ignore_invalid_symbol_tuple_returns_na_slots() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Ignored Invalid Symbol Tuple", overlay=True)
invalid_open, invalid_close = request.security(
    "MISSING",
    "2",
    ("open", "close"),
    ignore_invalid_symbol=True,
)
plot(invalid_open, "Invalid Open")
plot(invalid_close, "Invalid Close")
plot(na(invalid_open), "Invalid Open Is NA")
plot(na(invalid_close), "Invalid Close Is NA")
plot(nz(invalid_open, -111), "Invalid Open Fallback")
plot(nz(invalid_close, -222), "Invalid Close Fallback")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "2", 1, 4)]
    assert result.get_series("Invalid Open") == []
    assert result.get_series("Invalid Close") == []
    assert result.values("Invalid Open Is NA") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Invalid Close Is NA") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Invalid Open Fallback") == [-111.0, -111.0, -111.0, -111.0]
    assert result.values("Invalid Close Fallback") == [-222.0, -222.0, -222.0, -222.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "MISSING",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": True,
            "status": "ignoredInvalidSymbol",
        },
    ]


def test_request_security_ignore_invalid_symbol_thunk_returns_na() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Ignored Invalid Symbol Expression", overlay=True)
invalid_mid = request.security(
    "MISSING",
    "2",
    lambda ctx: (ctx.high + ctx.low) / 2,
    ignore_invalid_symbol=True,
)
plot(invalid_mid, "Invalid Mid")
plot(na(invalid_mid), "Invalid Mid Is NA")
plot(nz(invalid_mid, -333), "Invalid Mid Fallback")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "2", 1, 4)]
    assert result.get_series("Invalid Mid") == []
    assert result.values("Invalid Mid Is NA") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Invalid Mid Fallback") == [-333.0, -333.0, -333.0, -333.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "MISSING",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": True,
            "status": "ignoredInvalidSymbol",
        },
    ]


def test_request_security_empty_provider_result_is_successful_empty_data() -> None:
    class EmptyProvider(StaticProvider):
        def __init__(self) -> None:
            super().__init__([])
            self.metadata_calls: list[tuple[str, str]] = []

        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            self.metadata_calls.append((symbol, timeframe))
            return {"syminfo": {"tickerid": f"EMPTY:{symbol}"}}

    provider = EmptyProvider()

    result = pn.run(
        """
indicator("Empty Provider Result", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert provider.metadata_calls == [("BTCUSDT", "2")]
    assert result.get_series("Higher") == []
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        }
    ]


def test_request_security_empty_provider_result_reuses_cache_across_request_shapes() -> None:
    class EmptyProvider(StaticProvider):
        def __init__(self) -> None:
            super().__init__([])
            self.metadata_calls: list[tuple[str, str]] = []

        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            self.metadata_calls.append((symbol, timeframe))
            return {"syminfo": {"tickerid": f"EMPTY:{symbol}"}}

    provider = EmptyProvider()

    result = pn.run(
        """
indicator("Empty Provider Cache", overlay=True)
higher = request.security("BTCUSDT", "2", close)
lower = request.security_lower_tf("BTCUSDT", "2", close)
plot(higher, "Higher")
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert provider.metadata_calls == [("BTCUSDT", "2")]
    assert result.get_series("Higher") == []
    assert result.values("Lower Count") == [0.0, 0.0, 0.0, 0.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": True,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
    ]


def test_request_security_ignored_invalid_symbol_does_not_poison_cache() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Invalid Symbol Cache", overlay=True)
ignored = request.security("MISSING", "2", close, ignore_invalid_symbol=True)
bad = request.security("MISSING", "2", close)
plot(ignored, "Ignored")
plot(bad, "Bad")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_SYMBOL"
    assert provider.calls == [("MISSING", "2", 1, 4), ("MISSING", "2", 1, 4)]


def test_request_security_ignore_invalid_symbol_does_not_hide_invalid_return_type() -> None:
    class NoneReturnProvider(StaticProvider):
        def get_ohlcv(self, symbol: str, timeframe: str, start: int, end: int) -> Any:
            self.calls.append((symbol, timeframe, start, end))
            return None

    provider = NoneReturnProvider([])

    result = pn.run(
        """
indicator("Invalid Return Is Not Invalid Symbol", overlay=True)
higher = request.security("BTCUSDT", "2", close, ignore_invalid_symbol=True)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert result.error_detail is not None
    assert result.error_detail["code"] == "PYNE_RUNTIME_ERROR"
    assert result.error_detail["requestProviderCategory"] == "invalidReturnType"
    assert result.error_detail["requestProviderRequest"] == {
        "api": "request.security",
        "symbol": "BTCUSDT",
        "timeframe": "2",
        "start": 1,
        "end": 4,
    }


def test_request_security_ignored_invalid_symbol_does_not_poison_valid_request_cache() -> None:
    class MixedProvider(StaticProvider):
        def __init__(self) -> None:
            super().__init__([
                {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
                {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
            ])

        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> list[dict[str, Any]]:
            self.calls.append((symbol, timeframe, start, end))
            if symbol == "MISSING":
                raise pn.PyneInvalidSymbolError(symbol)
            return self._bars

    provider = MixedProvider()

    result = pn.run(
        """
indicator("Invalid Then Valid", overlay=True)
ignored = request.security("MISSING", "2", close, ignore_invalid_symbol=True)
valid = request.security("BTCUSDT", "2", close)
valid_again = request.security("BTCUSDT", "2", high)
plot(ignored, "Ignored")
plot(valid, "Valid")
plot(valid_again, "Valid High")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "2", 1, 4), ("BTCUSDT", "2", 1, 4)]
    assert result.get_series("Ignored") == []
    assert result.values("Valid") == [10, 10, 30]
    assert result.values("Valid High") == [11, 11, 31]


def test_request_security_respects_provider_capability_false() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities={"request.security": False},
    )

    result = pn.run(
        """
indicator("Unsupported Security", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "provider capability" in str(result.error)
    assert provider.calls == []


def test_request_security_rejects_explicit_missing_provider_capabilities() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities=None,
    )

    result = pn.run(
        """
indicator("Missing Capabilities", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert provider.calls == []


def test_request_security_rejects_capability_dict_without_matching_key() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities={"orders": True},
    )

    result = pn.run(
        """
indicator("Missing Capability Key", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert provider.calls == []


def test_request_security_wraps_capability_provider_failures() -> None:
    class BrokenCapabilityProvider(StaticProvider):
        def capabilities(self) -> set[str]:
            raise RuntimeError("capability service offline")

    provider = BrokenCapabilityProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Capability Failure", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "request capability provider failed" in str(result.error)
    assert "capability service offline" in str(result.error)
    assert provider.calls == []


def test_request_security_wraps_provider_failures() -> None:
    class BrokenProvider(StaticProvider):
        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> list[dict[str, Any]]:
            self.calls.append((symbol, timeframe, start, end))
            raise RuntimeError("database offline")

    provider = BrokenProvider([])

    result = pn.run(
        """
indicator("Provider Failure", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "request data provider failed" in str(result.error)
    assert "database offline" in str(result.error)
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]


def test_request_security_lower_tf_respects_provider_capability_false() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities={"request.security_lower_tf": False},
    )

    result = pn.run(
        """
indicator("Unsupported Lower", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "provider capability" in str(result.error)
    assert provider.calls == []


def test_request_security_accepts_provider_capability_method_aliases() -> None:
    class MethodCapabilityProvider(StaticProvider):
        def capabilities(self) -> set[str]:
            return {"request.security", "request.security_lower_tf"}

    provider = MethodCapabilityProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("Capability Method", overlay=True)
higher = request.security("BTCUSDT", "2", close)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(higher, "Higher")
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert provider.calls == [("BTCUSDT", "2", 1, 4), ("BTCUSDT", "1", 1, 4)]
    assert result.values("Higher") == [10, 10, 30]
    assert result.values("Lower Count") == [1.0, 0.0, 1.0, 0.0]


def test_request_security_accepts_dict_capability_aliases() -> None:
    provider = CapabilityProvider(
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
            {"time": 2, "open": 20, "high": 21, "low": 19, "close": 20, "volume": 2000},
            {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
            {"time": 4, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 4000},
        ],
        capabilities={"ohlcv": True, "lower_tf": True},
    )

    result = pn.run(
        """
indicator("Capability Dict Aliases", overlay=True)
higher = request.security("BTCUSDT", "2", close)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(higher, "Higher")
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4), ("BTCUSDT", "1", 1, 4)]
    assert result.values("Higher") == [10, 20, 30, 40]
    assert result.values("Lower Count") == [1.0, 1.0, 1.0, 1.0]


def test_request_security_dict_capabilities_allow_any_truthy_alias() -> None:
    provider = CapabilityProvider(
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
            {"time": 2, "open": 20, "high": 21, "low": 19, "close": 20, "volume": 2000},
            {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
            {"time": 4, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 4000},
        ],
        capabilities={
            "request.security": False,
            "ohlcv": True,
            "request.security_lower_tf": False,
            "lower_tf": True,
        },
    )

    result = pn.run(
        """
indicator("Capability Truthy Alias", overlay=True)
higher = request.security("BTCUSDT", "2", close)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(higher, "Higher")
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4), ("BTCUSDT", "1", 1, 4)]
    assert result.values("Higher") == [10, 20, 30, 40]
    assert result.values("Lower Count") == [1.0, 1.0, 1.0, 1.0]


def test_request_security_accepts_sequence_capability_aliases() -> None:
    provider = CapabilityProvider(
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
            {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
        ],
        capabilities={"security", "security_lower_tf"},
    )

    result = pn.run(
        """
indicator("Capability Sequence Aliases", overlay=True)
higher = request.security("BTCUSDT", "2", close)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(higher, "Higher")
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4), ("BTCUSDT", "1", 1, 4)]
    assert result.values("Higher") == [10, 10, 30]
    assert result.values("Lower Count") == [1.0, 0.0, 1.0, 0.0]


def test_request_security_reuses_requested_context_for_repeated_requests() -> None:
    class MetadataProvider(StaticProvider):
        def __init__(self, bars: list[dict[str, Any]]) -> None:
            super().__init__(bars)
            self.metadata_calls: list[tuple[str, str]] = []

        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            self.metadata_calls.append((symbol, timeframe))
            return {"syminfo": {"tickerid": f"TEST:{symbol}", "mintick": 0.5}}

    provider = MetadataProvider([
        {"time": 1, "open": 9, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 29, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Reuse", overlay=True)
higher_close = request.security("BTCUSDT", "2", "close")
higher_high = request.security("BTCUSDT", "2", lambda ctx: ctx.high)
higher_low, higher_open = request.security("BTCUSDT", "2", ("low", "open"))
plot(higher_close, "Higher Close")
plot(higher_high, "Higher High")
plot(higher_low, "Higher Low")
plot(higher_open, "Higher Open")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert provider.metadata_calls == [("BTCUSDT", "2")]
    assert result.values("Higher Close") == [10, 10, 30]
    assert result.values("Higher High") == [12, 12, 34]
    assert result.values("Higher Low") == [8, 8, 28]
    assert result.values("Higher Open") == [9, 9, 29]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 2,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 2,
            "cacheHit": True,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 2,
            "cacheHit": True,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
    ]


def test_request_security_reuses_provider_data_across_request_shapes() -> None:
    class BothCapabilitiesProvider(StaticProvider):
        capabilities = {"request.security": True, "request.security_lower_tf": True}

    provider = BothCapabilitiesProvider([
        {"time": 1, "open": 9, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 2, "open": 19, "high": 22, "low": 18, "close": 20, "volume": 2000},
        {"time": 3, "open": 29, "high": 32, "low": 28, "close": 30, "volume": 3000},
        {"time": 4, "open": 39, "high": 42, "low": 38, "close": 40, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Request Shape Reuse", overlay=True)
higher = request.security("BTCUSDT", "1", "close")
lower = request.security_lower_tf("BTCUSDT", "1", "close")
plot(higher, "Higher")
plot(lower.last(), "Lower Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert result.values("Higher") == [10, 20, 30, 40]
    assert result.values("Lower Last") == [10.0, 20.0, 30.0, 40.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 4,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 4,
            "cacheHit": True,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
    ]


def test_request_security_sorts_provider_bars_before_alignment() -> None:
    provider = StaticProvider([
        {"time": 3, "open": 29, "high": 34, "low": 28, "close": 30, "volume": 3000},
        {"time": 1, "open": 9, "high": 12, "low": 8, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Sorted Provider Bars", overlay=True)
higher = request.security("BTCUSDT", "2", "close")
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4)]
    assert result.values("Higher") == [10.0, 10.0, 30.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "2",
            "start": 1,
            "end": 4,
            "bars": 2,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        }
    ]


def test_request_security_does_not_cache_provider_data_across_runs() -> None:
    class ChangingProvider(StaticProvider):
        def __init__(self) -> None:
            super().__init__([])

        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> list[dict[str, Any]]:
            self.calls.append((symbol, timeframe, start, end))
            base = float(len(self.calls) * 10)
            return [
                {"time": 1, "open": base, "high": base, "low": base, "close": base, "volume": 1000},
                {
                    "time": 3,
                    "open": base + 20,
                    "high": base + 20,
                    "low": base + 20,
                    "close": base + 20,
                    "volume": 3000,
                },
            ]

    provider = ChangingProvider()
    script = """
indicator("MTF Run Boundary", overlay=True)
higher = request.security("BTCUSDT", "2", "close")
plot(higher, "Higher")
"""

    first = pn.run(script, _bars(), data_provider=provider, executor_mode="inline")
    second = pn.run(script, _bars(), data_provider=provider, executor_mode="inline")

    assert first.ok, first.error
    assert second.ok, second.error
    assert provider.calls == [("BTCUSDT", "2", 1, 4), ("BTCUSDT", "2", 1, 4)]
    assert first.values("Higher") == [10.0, 10.0, 30.0]
    assert second.values("Higher") == [20.0, 20.0, 40.0]


def test_request_security_lower_tf_does_not_cache_provider_data_across_runs() -> None:
    class ChangingProvider(StaticProvider):
        def __init__(self) -> None:
            super().__init__([])

        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> list[dict[str, Any]]:
            self.calls.append((symbol, timeframe, start, end))
            base = float(len(self.calls) * 10)
            return [
                {"time": 1, "open": base, "high": base, "low": base, "close": base, "volume": 1000},
                {
                    "time": 3,
                    "open": base + 20,
                    "high": base + 20,
                    "low": base + 20,
                    "close": base + 20,
                    "volume": 3000,
                },
            ]

    provider = ChangingProvider()
    script = """
indicator("Lower Run Boundary", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", "close")
plot(lower.last(default=0), "Lower Last")
"""

    first = pn.run(script, _bars(), data_provider=provider, executor_mode="inline")
    second = pn.run(script, _bars(), data_provider=provider, executor_mode="inline")

    assert first.ok, first.error
    assert second.ok, second.error
    assert provider.calls == [("BTCUSDT", "1", 1, 4), ("BTCUSDT", "1", 1, 4)]
    assert first.values("Lower Last") == [10.0, 0.0, 30.0, 0.0]
    assert second.values("Lower Last") == [20.0, 0.0, 40.0, 0.0]


def test_request_security_accepts_basic_expression_thunk() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Thunk", overlay=True)
higher = request.security("BTCUSDT", "2", lambda ctx: ctx.close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Higher") == [10, 10, 30]


def test_request_security_evaluates_ta_thunk_in_requested_context() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF SMA", overlay=True)
higher_sma = request.security("BTCUSDT", "2", lambda ctx: ctx.ta.sma(ctx.close, 2))
plot(higher_sma, "Higher SMA")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Higher SMA") == [20]


def test_request_security_applies_thunk_history_in_requested_context() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Thunk History", overlay=True)
higher_prev = request.security("BTCUSDT", "2", lambda ctx: ctx.close[1])
plot(higher_prev, "Higher Previous")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Higher Previous") == [10]


def test_request_security_accepts_composite_thunk_expression() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Composite", overlay=True)
higher_mid = request.security("BTCUSDT", "2", lambda ctx: (ctx.high + ctx.low) / 2)
plot(higher_mid, "Higher Mid")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Higher Mid") == [10, 10, 31]


def test_request_security_injects_provider_metadata_into_requested_context() -> None:
    class MetadataProvider(StaticProvider):
        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            assert symbol == "BTCUSDT"
            assert timeframe == "1D"
            return {
                "syminfo": {
                    "tickerid": "BINANCE:BTCUSDT",
                    "mintick": 0.5,
                    "currency": "USDT",
                    "type": "crypto",
                },
                "timeframe": "1D",
                "session": {"ismarket": False},
            }

    provider = MetadataProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Metadata", overlay=True)
mintick, prefix_match, daily, market = request.security(
    "BTCUSDT",
    "1D",
    lambda ctx: (
        ctx.syminfo.mintick,
        1 if ctx.syminfo.prefix == "BINANCE" else 0,
        1 if ctx.timeframe_info.isdaily else 0,
        ctx.session.ismarket,
    ),
)
plot(mintick, "Requested Mintick")
plot(prefix_match, "Requested Prefix")
plot(daily, "Requested Daily")
plot(market, "Requested Market")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Requested Mintick") == [0.5, 0.5, 0.5]
    assert result.values("Requested Prefix") == [1.0, 1.0, 1.0]
    assert result.values("Requested Daily") == [1.0, 1.0, 1.0]
    assert result.values("Requested Market") == [0.0, 0.0, 0.0]


def test_request_security_accepts_provider_metadata_key_aliases() -> None:
    class MetadataAliasProvider(StaticProvider):
        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            assert symbol == "AAPL"
            assert timeframe == "1D"
            return {
                "symbol_info": {
                    "tickerid": "NASDAQ:AAPL",
                    "mintick": 0.01,
                    "currency": "USD",
                },
                "timeframe_info": "1D",
                "session_info": {"ismarket": False},
            }

    provider = MetadataAliasProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Metadata Aliases", overlay=True)
mintick, prefix_match, daily, market = request.security(
    "AAPL",
    "1D",
    lambda ctx: (
        ctx.syminfo.mintick,
        1 if ctx.syminfo.prefix == "NASDAQ" else 0,
        1 if ctx.timeframe_info.isdaily else 0,
        ctx.session.ismarket,
    ),
)
plot(mintick, "Alias Mintick")
plot(prefix_match, "Alias Prefix")
plot(daily, "Alias Daily")
plot(market, "Alias Market")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Alias Mintick") == [0.01, 0.01, 0.01]
    assert result.values("Alias Prefix") == [1.0, 1.0, 1.0]
    assert result.values("Alias Daily") == [1.0, 1.0, 1.0]
    assert result.values("Alias Market") == [0.0, 0.0, 0.0]


def test_request_security_uses_requested_time_close_session_and_timeframe() -> None:
    class MetadataProvider(StaticProvider):
        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            return {
                "timeframe": "2",
                "session": {"ismarket": False},
            }

    provider = MetadataProvider([
        {
            "time": 1,
            "time_close": 2,
            "open": 10,
            "high": 12,
            "low": 8,
            "close": 10,
            "volume": 1000,
            "session_isfirstbar": True,
        },
        {
            "time": 3,
            "time_close": 4,
            "open": 30,
            "high": 34,
            "low": 28,
            "close": 30,
            "volume": 3000,
            "session": {"ismarket": True, "islastbar": True},
        },
    ])

    result = pn.run(
        """
indicator("MTF Time Session", overlay=True)
tc, mult, market, first, last = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: (
        ctx.time_close,
        ctx.timeframe_info.multiplier,
        ctx.session.ismarket,
        ctx.session.isfirstbar,
        ctx.session.islastbar,
    ),
    gaps="on",
)
plot(tc, "Requested Time Close")
plot(mult, "Requested Multiplier")
plot(market, "Requested Market")
plot(first, "Requested First")
plot(last, "Requested Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
        timeframe="15",
        session={"ismarket": True},
    )

    assert result.ok, result.error
    assert result.get_series("Requested Time Close") == [
        {"time": 2, "value": 2.0},
        {"time": 4, "value": 4.0},
    ]
    assert result.get_series("Requested Multiplier") == [
        {"time": 2, "value": 2.0},
        {"time": 4, "value": 2.0},
    ]
    assert result.get_series("Requested Market") == [
        {"time": 2, "value": 0.0},
        {"time": 4, "value": 1.0},
    ]
    assert result.get_series("Requested First") == [
        {"time": 2, "value": 1.0},
        {"time": 4, "value": 0.0},
    ]
    assert result.get_series("Requested Last") == [
        {"time": 2, "value": 0.0},
        {"time": 4, "value": 1.0},
    ]


def test_request_security_rejects_invalid_metadata_contract() -> None:
    class BadMetadataProvider(StaticProvider):
        request_metadata = ["not", "a", "mapping"]

    provider = BadMetadataProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Bad Metadata", overlay=True)
higher = request.security("BTCUSDT", "1D", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "request metadata must be a mapping" in str(result.error)


def test_request_security_wraps_metadata_provider_failures() -> None:
    class BrokenMetadataProvider(StaticProvider):
        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            raise RuntimeError("metadata service offline")

    provider = BrokenMetadataProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Metadata Failure", overlay=True)
higher = request.security("BTCUSDT", "1D", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "request metadata provider failed" in str(result.error)
    assert "metadata service offline" in str(result.error)


def test_request_security_accepts_tuple_thunk_expression() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 9, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 29, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Tuple", overlay=True)
higher_open, higher_close = request.security("BTCUSDT", "2", lambda ctx: (ctx.open, ctx.close))
plot(higher_open, "Higher Open")
plot(higher_close, "Higher Close")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Higher Open") == [9, 9, 29]
    assert result.values("Higher Close") == [10, 10, 30]


def test_request_security_accepts_tuple_field_expression() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 9, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 29, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Field Tuple", overlay=True)
higher_high, higher_low = request.security("BTCUSDT", "2", ("high", "low"), gaps="on")
plot(higher_high, "Higher High")
plot(higher_low, "Higher Low")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.get_series("Higher High") == [
        {"time": 2, "value": 12.0},
        {"time": 4, "value": 34.0},
    ]
    assert result.get_series("Higher Low") == [
        {"time": 2, "value": 8.0},
        {"time": 4, "value": 28.0},
    ]


def test_request_security_gaps_and_lookahead_work_with_thunks() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
    ])

    result = pn.run(
        """
indicator("MTF Policies", overlay=True)
gapped = request.security("BTCUSDT", "2", lambda ctx: ctx.close, gaps="on")
ahead = request.security("BTCUSDT", "2", lambda ctx: ctx.close, lookahead="on")
plot(gapped, "Gapped")
plot(ahead, "Ahead")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.get_series("Gapped") == [
        {"time": 2, "value": 10.0},
        {"time": 4, "value": 30.0},
    ]
    assert result.values("Ahead") == [10, 10, 30, 30]


def test_request_security_rejects_invalid_thunk_return_type() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Invalid Thunk", overlay=True)
bad = request.security("BTCUSDT", "2", lambda ctx: {"close": ctx.close})
plot(bad, "Bad")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "series, tuple of series, or scalar" in str(result.error)


def test_request_security_reports_thunk_exceptions() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Thunk Error", overlay=True)
bad = request.security("BTCUSDT", "2", lambda ctx: 1 / 0)
plot(bad, "Bad")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "expression failed" in str(result.error)


def test_request_security_wraps_invalid_provider_ohlcv_contract() -> None:
    provider = StaticProvider([
        {"open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Bad Provider Bars", overlay=True)
higher = request.security("BTCUSDT", "2", close)
plot(higher, "Higher")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "without time" in str(result.error)


def test_request_security_rejects_nested_requests() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Nested Request", overlay=True)
bad = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: request.security("BTCUSDT", "2", ctx.close),
)
plot(bad, "Bad")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "Nested request.security" in str(result.error)


def test_request_security_lower_tf_groups_requested_values_by_chart_bar() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 1, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 1100},
        {"time": 2, "open": 20, "high": 21, "low": 19, "close": 20, "volume": 2000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
        {"time": 3, "open": 31, "high": 32, "low": 30, "close": 31, "volume": 3100},
        {"time": 4, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Lower TF", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.close)
plot(lower.size(), "Lower Count")
plot(lower.last(), "Lower Last")
plot(lower[1].last(), "Previous Lower Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert result.values("Lower Count") == [2.0, 1.0, 2.0, 1.0]
    assert result.values("Lower Last") == [11.0, 20.0, 31.0, 40.0]
    assert result.values("Previous Lower Last") == [11.0, 20.0, 31.0]


def test_request_security_lower_tf_sorts_provider_bars_before_grouping() -> None:
    provider = StaticProvider([
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 4, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 4000},
        {"time": 1, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 1100},
        {"time": 3, "open": 31, "high": 32, "low": 30, "close": 31, "volume": 3100},
        {"time": 2, "open": 20, "high": 21, "low": 19, "close": 20, "volume": 2000},
    ])

    result = pn.run(
        """
indicator("Lower Sorted Provider Bars", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.close)
plot(lower.size(), "Lower Count")
plot(lower.last(), "Lower Last")
plot(lower[1].last(), "Previous Lower Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert result.values("Lower Count") == [2.0, 1.0, 2.0, 1.0]
    assert result.values("Lower Last") == [11.0, 20.0, 31.0, 40.0]
    assert result.values("Previous Lower Last") == [11.0, 20.0, 31.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 6,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        }
    ]


def test_request_security_lower_tf_reuses_requested_context_for_repeated_requests() -> None:
    class MetadataProvider(StaticProvider):
        def __init__(self, bars: list[dict[str, Any]]) -> None:
            super().__init__(bars)
            self.metadata_calls: list[tuple[str, str]] = []

        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            self.metadata_calls.append((symbol, timeframe))
            return {"syminfo": {"tickerid": f"TEST:{symbol}", "mintick": 0.5}}

    provider = MetadataProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 1, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 1100},
        {"time": 2, "open": 20, "high": 21, "low": 19, "close": 20, "volume": 2000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
        {"time": 3, "open": 31, "high": 32, "low": 30, "close": 31, "volume": 3100},
        {"time": 4, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Lower TF Reuse", overlay=True)
lower_close = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.close)
lower_high = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.high)
plot(lower_close.last(), "Lower Close")
plot(lower_high.max(), "Lower High")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert provider.metadata_calls == [("BTCUSDT", "1")]
    assert result.values("Lower Close") == [11.0, 20.0, 31.0, 40.0]
    assert result.values("Lower High") == [12.0, 21.0, 32.0, 41.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 6,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 6,
            "cacheHit": True,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
    ]


def test_request_security_lower_tf_ignore_invalid_symbol_returns_empty_groups() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Lower Invalid Symbol", overlay=True)
lower = request.security_lower_tf("MISSING", "1", close, ignore_invalid_symbol=True)
plot(lower.size(), "Lower Count")
plot(lower.last(), "Lower Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "1", 1, 4)]
    assert result.values("Lower Count") == [0.0, 0.0, 0.0, 0.0]
    assert result.get_series("Lower Last") == []
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "MISSING",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": True,
            "status": "ignoredInvalidSymbol",
        }
    ]


def test_request_security_lower_tf_ignore_invalid_symbol_tuple_returns_empty_groups() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Lower Invalid Symbol Tuple", overlay=True)
lower_open, lower_close = request.security_lower_tf(
    "MISSING",
    "1",
    ("open", "close"),
    ignore_invalid_symbol=True,
)
plot(lower_open.size(), "Lower Open Count")
plot(lower_close.size(), "Lower Close Count")
plot(lower_open.first(default=-111), "Lower Open First")
plot(lower_close.last(default=-222), "Lower Close Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "1", 1, 4)]
    assert result.values("Lower Open Count") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("Lower Close Count") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("Lower Open First") == [-111.0, -111.0, -111.0, -111.0]
    assert result.values("Lower Close Last") == [-222.0, -222.0, -222.0, -222.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "MISSING",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": True,
            "status": "ignoredInvalidSymbol",
        }
    ]


def test_request_security_lower_tf_ignore_invalid_symbol_thunk_returns_empty_groups() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Lower Invalid Symbol Expression", overlay=True)
lower_mid = request.security_lower_tf(
    "MISSING",
    "1",
    lambda ctx: (ctx.high + ctx.low) / 2,
    ignore_invalid_symbol=True,
)
plot(lower_mid.size(), "Lower Mid Count")
plot(lower_mid.first(default=-111), "Lower Mid First")
plot(lower_mid.last(default=-222), "Lower Mid Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("MISSING", "1", 1, 4)]
    assert result.values("Lower Mid Count") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("Lower Mid First") == [-111.0, -111.0, -111.0, -111.0]
    assert result.values("Lower Mid Last") == [-222.0, -222.0, -222.0, -222.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "MISSING",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": True,
            "status": "ignoredInvalidSymbol",
        }
    ]


def test_request_security_lower_tf_ignore_invalid_timeframe_returns_empty_groups() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])
    bars = [
        {"time": 0, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 3600, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 7200, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]

    result = pn.run(
        """
indicator("Ignored Invalid Lower Timeframe", overlay=True)
lower = request.security_lower_tf(
    "BTCUSDT",
    "240",
    close,
    ignore_invalid_timeframe=True,
)
plot(lower.size(), "Lower Count")
plot(lower.first(default=-1), "Lower First")
plot(lower.sum(default=0), "Lower Sum")
""",
        bars,
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == []
    assert result.values("Lower Count") == [0.0, 0.0, 0.0]
    assert result.values("Lower First") == [-1.0, -1.0, -1.0]
    assert result.values("Lower Sum") == [0.0, 0.0, 0.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "240",
            "start": 0,
            "end": 7200,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "ignoreInvalidTimeframe": True,
            "status": "ignoredInvalidTimeframe",
        },
    ]


def test_request_security_lower_tf_ignore_invalid_timeframe_tuple_returns_empty_groups() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])
    bars = [
        {"time": 0, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 3600, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 7200, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]

    result = pn.run(
        """
indicator("Ignored Invalid Lower Timeframe Tuple", overlay=True)
lower_open, lower_close = request.security_lower_tf(
    "BTCUSDT",
    "240",
    ("open", "close"),
    ignore_invalid_timeframe=True,
)
plot(lower_open.size(), "Lower Open Count")
plot(lower_close.size(), "Lower Close Count")
plot(lower_open.first(default=-111), "Lower Open First")
plot(lower_close.last(default=-222), "Lower Close Last")
""",
        bars,
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == []
    assert result.values("Lower Open Count") == [0.0, 0.0, 0.0]
    assert result.values("Lower Close Count") == [0.0, 0.0, 0.0]
    assert result.values("Lower Open First") == [-111.0, -111.0, -111.0]
    assert result.values("Lower Close Last") == [-222.0, -222.0, -222.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "240",
            "start": 0,
            "end": 7200,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "ignoreInvalidTimeframe": True,
            "status": "ignoredInvalidTimeframe",
        },
    ]


def test_request_security_lower_tf_empty_provider_result_is_successful_empty_data() -> None:
    class EmptyProvider(StaticProvider):
        def __init__(self) -> None:
            super().__init__([])
            self.metadata_calls: list[tuple[str, str]] = []

        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            self.metadata_calls.append((symbol, timeframe))
            return {"syminfo": {"tickerid": f"EMPTY:{symbol}"}}

    provider = EmptyProvider()

    result = pn.run(
        """
indicator("Lower Empty Provider Result", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
plot(lower.last(), "Lower Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert provider.metadata_calls == [("BTCUSDT", "1")]
    assert result.values("Lower Count") == [0.0, 0.0, 0.0, 0.0]
    assert result.get_series("Lower Last") == []
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 0,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        }
    ]


def test_request_security_lower_tf_ignored_invalid_symbol_does_not_poison_cache() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Lower Invalid Symbol Cache", overlay=True)
ignored = request.security_lower_tf("MISSING", "1", close, ignore_invalid_symbol=True)
bad = request.security_lower_tf("MISSING", "1", close)
plot(ignored.size(), "Ignored Lower Count")
plot(bad.size(), "Bad Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_SYMBOL"
    assert provider.calls == [("MISSING", "1", 1, 4), ("MISSING", "1", 1, 4)]


def test_request_security_lower_tf_ignore_invalid_symbol_does_not_hide_invalid_return_type() -> None:
    class NoneReturnProvider(StaticProvider):
        def get_ohlcv(self, symbol: str, timeframe: str, start: int, end: int) -> Any:
            self.calls.append((symbol, timeframe, start, end))
            return None

    provider = NoneReturnProvider([])

    result = pn.run(
        """
indicator("Lower Invalid Return Is Not Invalid Symbol", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close, ignore_invalid_symbol=True)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert result.error_detail is not None
    assert result.error_detail["code"] == "PYNE_RUNTIME_ERROR"
    assert result.error_detail["requestProviderCategory"] == "invalidReturnType"
    assert result.error_detail["requestProviderRequest"] == {
        "api": "request.security_lower_tf",
        "symbol": "BTCUSDT",
        "timeframe": "1",
        "start": 1,
        "end": 4,
    }


def test_request_security_lower_tf_invalid_symbol_reports_request_context() -> None:
    provider = InvalidSymbolProvider()

    result = pn.run(
        """
indicator("Lower Invalid Symbol Error", overlay=True)
lower = request.security_lower_tf("MISSING", "1", close)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert provider.calls == [("MISSING", "1", 1, 4)]
    assert result.error_detail is not None
    assert result.error_detail["code"] == "PYNE_INVALID_SYMBOL"
    assert result.error_detail["requestProviderCategory"] == "invalidSymbol"
    assert result.error_detail["requestProviderRequest"] == {
        "api": "request.security_lower_tf",
        "symbol": "MISSING",
        "timeframe": "1",
        "start": 1,
        "end": 4,
    }


def test_request_security_lower_tf_accepts_field_tuple_expression() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 1000},
        {"time": 2, "open": 20, "high": 22, "low": 19, "close": 21, "volume": 2000},
        {"time": 3, "open": 30, "high": 32, "low": 29, "close": 31, "volume": 3000},
        {"time": 4, "open": 40, "high": 42, "low": 39, "close": 41, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Lower Tuple", overlay=True)
lower_high, lower_low = request.security_lower_tf("BTCUSDT", "1", ("high", "low"))
plot(lower_high.first(), "Lower High First")
plot(lower_low.last(), "Lower Low Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Lower High First") == [12.0, 22.0, 32.0, 42.0]
    assert result.values("Lower Low Last") == [9.0, 19.0, 29.0, 39.0]


def test_request_security_lower_tf_accepts_tuple_thunk_expression() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 1000},
        {"time": 1, "open": 12, "high": 15, "low": 11, "close": 14, "volume": 1100},
        {"time": 2, "open": 20, "high": 23, "low": 19, "close": 21, "volume": 2000},
        {"time": 3, "open": 30, "high": 33, "low": 28, "close": 31, "volume": 3000},
        {"time": 3, "open": 32, "high": 36, "low": 30, "close": 35, "volume": 3100},
        {"time": 4, "open": 40, "high": 44, "low": 39, "close": 41, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Lower Tuple Thunk", overlay=True)
lower_sum, lower_range = request.security_lower_tf(
    "BTCUSDT",
    "1",
    lambda ctx: (ctx.open + ctx.close, ctx.high - ctx.low),
)
plot(lower_sum.first(), "Lower Sum First")
plot(lower_range.max(), "Lower Range Max")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert result.values("Lower Sum First") == [21.0, 41.0, 61.0, 81.0]
    assert result.values("Lower Range Max") == [4.0, 4.0, 6.0, 5.0]
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
            "bars": 6,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        }
    ]


def test_request_security_lower_tf_rejects_invalid_thunk_return_type() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Lower Invalid Thunk", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", lambda ctx: {"close": ctx.close})
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "series, tuple of series, or scalar" in str(result.error)
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]


def test_request_security_lower_tf_rejects_nested_requests() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Lower Nested Request", overlay=True)
lower = request.security_lower_tf(
    "BTCUSDT",
    "1",
    lambda ctx: request.security_lower_tf("BTCUSDT", "1", ctx.close),
)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "Nested request.security_lower_tf" in str(result.error)
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]


def test_request_security_lower_tf_injects_provider_metadata_into_requested_context() -> None:
    class MetadataProvider(StaticProvider):
        request_metadata = {
            "syminfo": {"tickerid": "COINBASE:ETHUSD", "mintick": 0.25},
            "timeframe": "5",
            "session": {"ismarket": False},
        }

    provider = MetadataProvider([
        {"time": 1, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 1000},
        {"time": 2, "open": 20, "high": 22, "low": 19, "close": 21, "volume": 2000},
        {"time": 3, "open": 30, "high": 32, "low": 29, "close": 31, "volume": 3000},
        {"time": 4, "open": 40, "high": 42, "low": 39, "close": 41, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Lower Metadata", overlay=True)
lower = request.security_lower_tf(
    "ETHUSD",
    "5",
    lambda ctx: ctx.syminfo.mintick + ctx.timeframe_info.multiplier + ctx.session.ismarket,
)
plot(lower.last(), "Lower Metadata")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Lower Metadata") == [5.25, 5.25, 5.25, 5.25]


def test_request_security_lower_tf_accepts_provider_metadata_key_aliases() -> None:
    class MetadataAliasProvider(StaticProvider):
        request_metadata = {
            "symbol_info": {"tickerid": "COINBASE:ETHUSD", "mintick": 0.25},
            "timeframe_info": "5",
            "session_info": {"ismarket": False},
        }

    provider = MetadataAliasProvider([
        {"time": 1, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 1000},
        {"time": 2, "open": 20, "high": 22, "low": 19, "close": 21, "volume": 2000},
        {"time": 3, "open": 30, "high": 32, "low": 29, "close": 31, "volume": 3000},
        {"time": 4, "open": 40, "high": 42, "low": 39, "close": 41, "volume": 4000},
    ])

    result = pn.run(
        """
indicator("Lower Metadata Aliases", overlay=True)
lower = request.security_lower_tf(
    "ETHUSD",
    "5",
    lambda ctx: ctx.syminfo.mintick + ctx.timeframe_info.multiplier + ctx.session.ismarket,
)
plot(lower.last(), "Lower Alias Metadata")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Lower Alias Metadata") == [5.25, 5.25, 5.25, 5.25]


def test_request_security_lower_tf_uses_requested_time_close_session_and_timeframe() -> None:
    class MetadataProvider(StaticProvider):
        request_metadata = {
            "timeframe": "5",
            "session": {"ismarket": False},
        }

    provider = MetadataProvider([
        {
            "time": 1,
            "time_close": 11,
            "open": 10,
            "high": 12,
            "low": 9,
            "close": 11,
            "volume": 1000,
            "session_isfirstbar": True,
        },
        {
            "time": 1,
            "time_close": 12,
            "open": 12,
            "high": 14,
            "low": 11,
            "close": 13,
            "volume": 1200,
        },
        {
            "time": 2,
            "time_close": 22,
            "open": 20,
            "high": 22,
            "low": 19,
            "close": 21,
            "volume": 2000,
            "session": {"ismarket": True},
        },
        {
            "time": 3,
            "time_close": 33,
            "open": 30,
            "high": 32,
            "low": 29,
            "close": 31,
            "volume": 3000,
        },
        {
            "time": 4,
            "time_close": 44,
            "open": 40,
            "high": 42,
            "low": 39,
            "close": 41,
            "volume": 4000,
            "session_islastbar": True,
        },
    ])

    result = pn.run(
        """
indicator("Lower Time Session", overlay=True)
tc, mult, market, first, last = request.security_lower_tf(
    "ETHUSD",
    "5",
    lambda ctx: (
        ctx.time_close,
        ctx.timeframe_info.multiplier,
        ctx.session.ismarket,
        ctx.session.isfirstbar,
        ctx.session.islastbar,
    ),
)
plot(tc.last(), "Lower Time Close")
plot(mult.last(), "Lower Multiplier")
plot(market.last(), "Lower Market")
plot(first.last(), "Lower First")
plot(last.last(), "Lower Last")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
        timeframe="60",
        session={"ismarket": True},
    )

    assert result.ok, result.error
    assert result.values("Lower Time Close") == [12.0, 22.0, 33.0, 44.0]
    assert result.values("Lower Multiplier") == [5.0, 5.0, 5.0, 5.0]
    assert result.values("Lower Market") == [0.0, 1.0, 0.0, 0.0]
    assert result.values("Lower First") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("Lower Last") == [0.0, 0.0, 0.0, 1.0]


def test_request_security_lower_tf_exposes_array_like_numeric_helpers() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 100},
        {"time": 1, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 200},
        {"time": 1, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 300},
        {"time": 3, "open": 4, "high": 4, "low": 4, "close": 4, "volume": 400},
        {"time": 3, "open": 5, "high": 5, "low": 5, "close": 5, "volume": 500},
    ])

    result = pn.run(
        """
indicator("Lower Helpers", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.close)
plot(lower.get(1), "Second")
plot(lower.sum(), "Sum")
plot(lower.min(), "Min")
plot(lower.max(), "Max")
plot(lower.avg(), "Average")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Second") == [2.0, 5.0]
    assert result.values("Sum") == [6.0, 9.0]
    assert result.values("Min") == [1.0, 4.0]
    assert result.values("Max") == [3.0, 5.0]
    assert result.values("Average") == [2.0, 4.5]


def test_request_security_lower_tf_helpers_use_default_for_empty_groups() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 100},
        {"time": 4, "open": 4, "high": 4, "low": 4, "close": 4, "volume": 400},
    ])

    result = pn.run(
        """
indicator("Lower Empty", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", "close")
plot(lower.get(1, default=0), "Second")
plot(lower.sum(default=0), "Sum")
plot(lower.min(default=-1), "Min")
plot(lower.avg(default=0), "Average")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Second") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("Sum") == [1.0, 0.0, 0.0, 4.0]
    assert result.values("Min") == [1.0, -1.0, -1.0, 4.0]
    assert result.values("Average") == [1.0, 0.0, 0.0, 4.0]


def test_request_security_lower_tf_respects_provider_capabilities() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities={"security_lower_tf": False},
    )

    result = pn.run(
        """
indicator("Lower Unsupported", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "provider capability" in str(result.error)


def test_request_security_lower_tf_rejects_missing_list_capability() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities={"request.security"},
    )

    result = pn.run(
        """
indicator("Lower Missing Capability", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_UNSUPPORTED_FEATURE"
    assert "provider capability" in str(result.error)
    assert provider.calls == []


def test_request_security_lower_tf_availability_errors_report_request_context() -> None:
    provider = CapabilityProvider(
        [{"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000}],
        capabilities={"request.security_lower_tf": False},
    )
    cases = [
        ("missingProvider", None),
        ("unsupportedCapability", provider),
    ]

    for category, data_provider in cases:
        result = pn.run(
            """
indicator("Lower Availability Error", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
            _bars(),
            data_provider=data_provider,
            executor_mode="inline",
        )

        assert not result.ok, category
        assert result.error_detail is not None
        assert result.error_detail["code"] == "PYNE_UNSUPPORTED_FEATURE"
        assert result.error_detail["requestProviderCategory"] == category
        assert result.error_detail["requestProviderRequest"] == {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
        }

    assert provider.calls == []


def test_request_security_lower_tf_capability_failure_reports_request_context() -> None:
    class BrokenCapabilityProvider(StaticProvider):
        def capabilities(self) -> set[str]:
            raise RuntimeError("capability offline")

    provider = BrokenCapabilityProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Lower Capability Failure", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert result.error_detail is not None
    assert result.error_detail["code"] == "PYNE_RUNTIME_ERROR"
    assert result.error_detail["requestProviderCategory"] == "capabilityFailure"
    assert result.error_detail["requestProviderRequest"] == {
        "api": "request.security_lower_tf",
        "symbol": "BTCUSDT",
        "timeframe": "1",
        "start": 1,
        "end": 4,
    }
    assert provider.calls == []


def test_request_security_lower_tf_expression_errors_report_request_context() -> None:
    provider = StaticProvider([
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ])

    result = pn.run(
        """
indicator("Lower Expression Error", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", lambda ctx: 1 / 0)
plot(lower.size(), "Lower Count")
""",
        _bars(),
        data_provider=provider,
        executor_mode="inline",
    )

    assert not result.ok
    assert provider.calls == [("BTCUSDT", "1", 1, 4)]
    assert result.error_detail is not None
    assert result.error_detail["code"] == "PYNE_RUNTIME_ERROR"
    assert result.error_detail["requestProviderCategory"] == "expressionFailure"
    assert result.error_detail["requestProviderRequest"] == {
        "api": "request.security_lower_tf",
        "symbol": "BTCUSDT",
        "timeframe": "1",
        "start": 1,
        "end": 4,
    }


def test_request_security_lower_tf_metadata_errors_report_request_context() -> None:
    class BadMetadataProvider(StaticProvider):
        request_metadata = ["not", "a", "mapping"]

    class BrokenMetadataProvider(StaticProvider):
        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            raise RuntimeError("metadata offline")

    requested_bars = [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ]
    cases = [
        ("invalidMetadata", BadMetadataProvider(requested_bars)),
        ("metadataFailure", BrokenMetadataProvider(requested_bars)),
    ]

    for category, provider in cases:
        result = pn.run(
            """
indicator("Lower Metadata Error", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
            _bars(),
            data_provider=provider,
            executor_mode="inline",
        )

        assert not result.ok, category
        assert result.error_detail is not None
        assert result.error_detail["code"] == "PYNE_RUNTIME_ERROR"
        assert result.error_detail["requestProviderCategory"] == category
        assert result.error_detail["requestProviderRequest"] == {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
        }


def test_request_security_lower_tf_provider_data_errors_report_request_context() -> None:
    class BrokenProvider(StaticProvider):
        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> list[dict[str, Any]]:
            self.calls.append((symbol, timeframe, start, end))
            raise RuntimeError("database offline")

    class InvalidReturnProvider(StaticProvider):
        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> Any:
            self.calls.append((symbol, timeframe, start, end))
            return "not bars"

    valid_requested_bars = [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ]
    cases = [
        ("providerFailure", BrokenProvider(valid_requested_bars)),
        ("invalidReturnType", InvalidReturnProvider(valid_requested_bars)),
        (
            "invalidBarShape",
            StaticProvider([
                {"open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
            ]),
        ),
    ]

    for category, provider in cases:
        result = pn.run(
            """
indicator("Lower Provider Data Error", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
            _bars(),
            data_provider=provider,
            executor_mode="inline",
        )

        assert not result.ok, category
        assert result.error_detail is not None
        assert result.error_detail["code"] == "PYNE_RUNTIME_ERROR"
        assert result.error_detail["requestProviderCategory"] == category
        assert result.error_detail["requestProviderRequest"] == {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 4,
        }


def test_request_provider_error_detail_categories_match_schema() -> None:
    class BrokenProvider(StaticProvider):
        def get_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            start: int,
            end: int,
        ) -> list[dict[str, Any]]:
            self.calls.append((symbol, timeframe, start, end))
            raise RuntimeError("database offline")

    class InvalidReturnProvider(StaticProvider):
        def get_ohlcv(self, symbol: str, timeframe: str, start: int, end: int) -> Any:
            self.calls.append((symbol, timeframe, start, end))
            return "not bars"

    class BrokenCapabilityProvider(StaticProvider):
        def capabilities(self) -> set[str]:
            raise RuntimeError("capability offline")

    class BadMetadataProvider(StaticProvider):
        request_metadata = ["not", "a", "mapping"]

    class BrokenMetadataProvider(StaticProvider):
        def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
            raise RuntimeError("metadata offline")

    valid_requested_bars = [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ]
    invalid_bar_shape = [
        {"open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
    ]

    def provider_for(category: str, api: str) -> Any:
        if category == "missingProvider":
            return None
        if category == "unsupportedCapability":
            return CapabilityProvider(valid_requested_bars, capabilities={api: False})
        if category == "capabilityFailure":
            return BrokenCapabilityProvider(valid_requested_bars)
        if category == "invalidSymbol":
            return InvalidSymbolProvider()
        if category == "providerFailure":
            return BrokenProvider([])
        if category == "invalidReturnType":
            return InvalidReturnProvider([])
        if category == "invalidBarShape":
            return StaticProvider(invalid_bar_shape)
        if category == "invalidMetadata":
            return BadMetadataProvider(valid_requested_bars)
        if category == "metadataFailure":
            return BrokenMetadataProvider(valid_requested_bars)
        if category == "expressionFailure":
            return StaticProvider(valid_requested_bars)
        raise AssertionError(f"unhandled category {category}")

    security_scripts = {
        "missingProvider": """
indicator("Missing Provider", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "unsupportedCapability": """
indicator("Unsupported Capability", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "capabilityFailure": """
indicator("Capability Failure", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "invalidSymbol": """
indicator("Invalid Symbol", overlay=True)
plot(request.security("MISSING", "2", close), "Higher")
""",
        "providerFailure": """
indicator("Provider Failure", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "invalidReturnType": """
indicator("Invalid Return", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "invalidBarShape": """
indicator("Invalid Bar", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "invalidMetadata": """
indicator("Invalid Metadata", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "metadataFailure": """
indicator("Metadata Failure", overlay=True)
plot(request.security("BTCUSDT", "2", close), "Higher")
""",
        "expressionFailure": """
indicator("Expression Failure", overlay=True)
bad = request.security("BTCUSDT", "2", lambda ctx: 1 / 0)
plot(bad, "Bad")
""",
    }
    lower_tf_scripts = {
        "missingProvider": """
indicator("Missing Lower Provider", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "unsupportedCapability": """
indicator("Unsupported Lower Capability", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "capabilityFailure": """
indicator("Lower Capability Failure", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "invalidSymbol": """
indicator("Lower Invalid Symbol", overlay=True)
lower = request.security_lower_tf("MISSING", "1", close)
plot(lower.size(), "Lower Count")
""",
        "providerFailure": """
indicator("Lower Provider Failure", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "invalidReturnType": """
indicator("Lower Invalid Return", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "invalidBarShape": """
indicator("Lower Invalid Bar", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "invalidMetadata": """
indicator("Lower Invalid Metadata", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "metadataFailure": """
indicator("Lower Metadata Failure", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", close)
plot(lower.size(), "Lower Count")
""",
        "expressionFailure": """
indicator("Lower Expression Failure", overlay=True)
lower = request.security_lower_tf("BTCUSDT", "1", lambda ctx: 1 / 0)
plot(lower.size(), "Lower Count")
""",
    }

    error_categories = pn.schema()["requestProvider"]["errorCategories"]

    for api, timeframe, scripts in (
        (pn.REQUEST_SECURITY_API, "2", security_scripts),
        (pn.REQUEST_SECURITY_LOWER_TF_API, "1", lower_tf_scripts),
    ):
        for category, script in scripts.items():
            result = pn.run(
                script,
                _bars(),
                data_provider=provider_for(category, api),
                executor_mode="inline",
            )

            assert not result.ok, (api, category)
            assert result.error_detail is not None
            assert result.error_detail["requestProviderCategory"] == category
            assert result.error_detail["requestProviderRequest"] == {
                "api": api,
                "symbol": "BTCUSDT" if category != "invalidSymbol" else "MISSING",
                "timeframe": timeframe,
                "start": 1,
                "end": 4,
            }
            assert result.error_detail["code"] == error_categories[category]["code"]
