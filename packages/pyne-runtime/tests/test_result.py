from __future__ import annotations

from pyne_runtime import PYNE_OUTPUT_SCHEMA_VERSION, PYNE_PARAM_SCHEMA_VERSION, PyneResult


def test_result_to_dict_includes_schema_version() -> None:
    result = PyneResult(lines=[{"name": "Close", "data": [{"time": 1, "value": 2.0}]}])

    payload = result.to_dict()

    assert payload["schemaVersion"] == PYNE_OUTPUT_SCHEMA_VERSION
    assert payload["paramSchemaVersion"] == PYNE_PARAM_SCHEMA_VERSION
    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Close"


def test_result_from_dict_preserves_schema_version() -> None:
    result = PyneResult.from_dict({
        "schemaVersion": 7,
        "paramSchemaVersion": 3,
        "ok": True,
        "lines": [],
        "output": {},
        "param_schema": [],
        "meta": {},
    })

    assert result.schema_version == 7
    assert result.param_schema_version == 3


def test_result_error_detail_is_structured() -> None:
    result = PyneResult(ok=False, code="PYNE_RUNTIME_ERROR", error="boom", hint="fix it")

    assert result.error_detail == {
        "code": "PYNE_RUNTIME_ERROR",
        "message": "boom",
        "hint": "fix it",
        "docsUrl": (
            "https://github.com/Ryan00956/pyne-runtime/tree/main/docs/"
            "reference/error_codes.md#pyne-runtime-error"
        ),
    }


def test_result_error_detail_preserves_extra_context() -> None:
    result = PyneResult(
        ok=False,
        code="PYNE_RUNTIME_ERROR",
        error="boom",
        error_context={"requestProviderCategory": "providerFailure"},
    )

    assert result.error_detail["requestProviderCategory"] == "providerFailure"
    assert result.to_dict()["errorDetail"]["requestProviderCategory"] == "providerFailure"

    restored = PyneResult.from_dict(result.to_dict())

    assert restored.error_detail["requestProviderCategory"] == "providerFailure"


def test_result_series_helpers() -> None:
    result = PyneResult(lines=[
        {
            "name": "Close",
            "data": [
                {"time": 1, "value": None},
                {"time": 2, "value": 2.0},
                {"time": 3, "value": 3.0},
            ],
        },
        {"name": "Signal", "data": [{"time": 3, "value": 1}]},
    ])

    assert result.series_names == ["Close", "Signal"]
    assert result.get_series("Close")[1]["value"] == 2.0
    assert result.values("Close") == [None, 2.0, 3.0]
    assert result.latest("Close") == 3.0


def test_result_series_helpers_raise_for_unknown_name() -> None:
    result = PyneResult(lines=[])

    try:
        result.get_series("Missing")
    except KeyError as exc:
        assert "Missing" in str(exc)
    else:
        raise AssertionError("Expected KeyError for missing series")


def test_result_to_frame_disambiguates_duplicate_series_names() -> None:
    result = PyneResult(lines=[
        {"name": "Close", "data": [{"time": 1, "value": 1.0}]},
        {"name": "Close", "data": [{"time": 1, "value": 2.0}]},
    ])

    frame = result.to_frame()

    assert frame.to_dict(orient="records") == [
        {"time": 1, "Close": 1.0, "Close_2": 2.0},
    ]
