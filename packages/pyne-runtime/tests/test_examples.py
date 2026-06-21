from __future__ import annotations

from pathlib import Path
from typing import Any

import pyne_runtime as pn


EXAMPLES_DIR = Path(__file__).resolve().parents[1] / "examples"
EXAMPLES_README = EXAMPLES_DIR / "README.md"


def test_all_packaged_examples_run() -> None:
    data = pn.read_ohlcv(EXAMPLES_DIR / "sample_ohlcv.csv")

    for script in sorted(EXAMPLES_DIR.glob("*.py")):
        run_kwargs: dict[str, Any] = {}
        if script.name == "request_provider_contract.py":
            run_kwargs["data_provider"] = _RequestExampleProvider()
            run_kwargs["executor_mode"] = "inline"
        result = pn.run(script, data, **run_kwargs)

        assert result.ok, f"{script.name} failed: {result.error}"
        assert result.meta.get("title")
        assert result.lines or result.output


def test_examples_readme_covers_packaged_scripts_and_data_fixture() -> None:
    body = EXAMPLES_README.read_text(encoding="utf-8")

    for script in sorted(EXAMPLES_DIR.glob("*.py")):
        assert f"`{script.name}`" in body

    assert "`sample_ohlcv.csv`" in body
    assert "pyne run examples/ma_cross.py" in body
    assert "pyne validate examples/ma_cross.py" in body


def test_request_provider_contract_example_exposes_request_diagnostics() -> None:
    data = pn.read_ohlcv(EXAMPLES_DIR / "sample_ohlcv.csv")
    provider = _RequestExampleProvider()
    result = pn.run(
        EXAMPLES_DIR / "request_provider_contract.py",
        data,
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert provider.calls == [("BTCUSDT", "5", 1, 20), ("BTCUSDT", "1", 1, 20)]
    assert provider.metadata_calls == [("BTCUSDT", "5"), ("BTCUSDT", "1")]
    assert result.get_series("Higher Open") == [
        {"time": 5, "value": 100.0},
        {"time": 6, "value": 100.0},
        {"time": 7, "value": 100.0},
        {"time": 8, "value": 100.0},
        {"time": 9, "value": 100.0},
        {"time": 10, "value": 105.0},
        {"time": 11, "value": 105.0},
        {"time": 12, "value": 105.0},
        {"time": 13, "value": 105.0},
        {"time": 14, "value": 105.0},
        {"time": 15, "value": 110.0},
        {"time": 16, "value": 110.0},
        {"time": 17, "value": 110.0},
        {"time": 18, "value": 110.0},
        {"time": 19, "value": 110.0},
        {"time": 20, "value": 115.0},
    ]
    assert result.values("Higher Mintick") == [0.01] * 16
    assert result.values("Lower Count") == [1.0] * 20
    assert result.meta["requestDiagnostics"] == [
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "5",
            "start": 1,
            "end": 20,
            "bars": 4,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security",
            "symbol": "BTCUSDT",
            "timeframe": "5",
            "start": 1,
            "end": 20,
            "bars": 4,
            "cacheHit": True,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
        {
            "api": "request.security_lower_tf",
            "symbol": "BTCUSDT",
            "timeframe": "1",
            "start": 1,
            "end": 20,
            "bars": 20,
            "cacheHit": False,
            "ignoreInvalidSymbol": False,
            "status": "ok",
        },
    ]


def test_host_output_contract_example_matches_schema() -> None:
    data = pn.read_ohlcv(EXAMPLES_DIR / "sample_ohlcv.csv")
    result = pn.run(EXAMPLES_DIR / "host_output_contract.py", data)
    schema = pn.schema()["output"]

    assert result.ok, result.error
    assert result.schema_version == schema["schemaVersion"]

    for key, contract in schema["renderables"].items():
        assert key in result.output
        _assert_required_fields(result.output[key][0], contract["required"])

        point_required = contract.get("pointRequired")
        if point_required:
            _assert_required_fields(result.output[key][0]["data"][0], point_required)

        region_required = contract.get("regionRequired")
        if region_required:
            _assert_required_fields(result.output[key][0]["regions"][0], region_required)

    objects = result.output["objects"]
    object_contract = schema["objects"]
    assert set(objects) == set(object_contract["groups"])
    for group in object_contract["groups"]:
        _assert_required_fields(objects[group][0], object_contract[group]["required"])

    table_cell = objects["tables"][0]["cells"][0]
    _assert_required_fields(table_cell, object_contract["tables"]["cellRequired"])


def _assert_required_fields(payload: dict[str, Any], fields: list[str]) -> None:
    for field in fields:
        assert field in payload


class _RequestExampleProvider:
    capabilities: pn.RequestCapabilities = {
        "request.security": True,
        "request.security_lower_tf": True,
    }

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, int, int]] = []
        self.metadata_calls: list[tuple[str, str]] = []

    def get_request_metadata(self, symbol: str, timeframe: str) -> pn.RequestMetadata:
        self.metadata_calls.append((symbol, timeframe))
        return {
            "syminfo": {
                "tickerid": f"BINANCE:{symbol}",
                "mintick": 0.01,
                "currency": "USDT",
                "type": "crypto",
            },
            "timeframe": {"period": timeframe},
            "session": {"ismarket": True},
        }

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[dict[str, Any]]:
        self.calls.append((symbol, timeframe, start, end))
        bars = {
            "5": [
                {"time": 1, "open": 100, "high": 106, "low": 99, "close": 105, "volume": 5000},
                {"time": 6, "open": 105, "high": 111, "low": 104, "close": 110, "volume": 5500},
                {"time": 11, "open": 110, "high": 116, "low": 109, "close": 115, "volume": 6000},
                {"time": 16, "open": 115, "high": 121, "low": 114, "close": 120, "volume": 6500},
            ],
            "1": [
                {
                    "time": time,
                    "open": 99 + time,
                    "high": 101 + time,
                    "low": 98 + time,
                    "close": 100 + time,
                    "volume": 1000 + time,
                }
                for time in range(1, 21)
            ],
        }[timeframe]
        return [bar for bar in bars if start <= int(bar["time"]) <= end]
