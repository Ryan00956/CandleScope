from __future__ import annotations

from pyne_runtime import PYNE_OUTPUT_SCHEMA_VERSION, PyneResult


def test_result_to_dict_includes_schema_version() -> None:
    result = PyneResult(lines=[{"name": "Close", "data": [{"time": 1, "value": 2.0}]}])

    payload = result.to_dict()

    assert payload["schemaVersion"] == PYNE_OUTPUT_SCHEMA_VERSION
    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Close"


def test_result_from_dict_preserves_schema_version() -> None:
    result = PyneResult.from_dict({
        "schemaVersion": 7,
        "ok": True,
        "lines": [],
        "output": {},
        "param_schema": [],
        "meta": {},
    })

    assert result.schema_version == 7


def test_result_error_detail_is_structured() -> None:
    result = PyneResult(ok=False, code="PYNE_RUNTIME_ERROR", error="boom", hint="fix it")

    assert result.error_detail == {
        "code": "PYNE_RUNTIME_ERROR",
        "message": "boom",
        "hint": "fix it",
        "docsUrl": (
            "https://github.com/CandleScope/CandleScope/tree/main/packages/"
            "pyne-runtime/docs/reference/error_codes.md#pyne-runtime-error"
        ),
    }
