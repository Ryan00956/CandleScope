from __future__ import annotations

import pyne_runtime as pn


def test_schema_bundle_exposes_versions_and_contracts() -> None:
    schema = pn.schema()

    assert schema["input"]["schemaVersion"] == pn.PYNE_INPUT_SCHEMA_VERSION
    assert schema["output"]["schemaVersion"] == pn.PYNE_OUTPUT_SCHEMA_VERSION
    assert schema["input"]["required"] == ["time", "open", "high", "low", "close", "volume"]
    assert "lines" in schema["output"]["outputKeys"]
