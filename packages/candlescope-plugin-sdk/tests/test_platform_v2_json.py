from __future__ import annotations

import pytest

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    canonical_dumps,
    canonical_sha256,
    loads_strict,
)


def test_canonical_json_is_deterministic_and_language_neutral() -> None:
    value = {"z": 1e-7, "a": 1e10, "n": -0.0, "u": "中"}

    assert canonical_dumps(value) == ('{"a":10000000000,"n":0,"u":"中","z":1e-7}')
    assert canonical_sha256(value) == (
        "sha256:4c33eec3c31b81760ae957a39c438b68ea58a5d41f58abafc9bdcc052b15e1ec"
    )
    assert loads_strict(canonical_dumps(value).encode("utf-8")) == {
        "a": 10000000000,
        "n": 0,
        "u": "中",
        "z": 1e-7,
    }


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ('{"a":1,"a":2}', "DUPLICATE_JSON_KEY"),
        ('{"value":NaN}', "NON_FINITE_NUMBER"),
        ('{"value":Infinity}', "NON_FINITE_NUMBER"),
        ('{"value":9007199254740992}', "UNSAFE_INTEGER"),
        ('{"value":1e999}', "NON_FINITE_NUMBER"),
    ],
)
def test_strict_json_rejects_ambiguous_numbers_and_duplicate_keys(
    payload: str,
    code: str,
) -> None:
    with pytest.raises(PlatformContractError) as raised:
        loads_strict(payload)

    assert raised.value.code == code


def test_strict_json_enforces_message_depth_container_and_string_limits() -> None:
    with pytest.raises(PlatformContractError, match="exceeds 8 bytes"):
        loads_strict('{"x":123}', limits=JsonLimits(max_message_bytes=8))
    with pytest.raises(PlatformContractError) as deep:
        loads_strict("[[[0]]]", limits=JsonLimits(max_depth=2))
    with pytest.raises(PlatformContractError) as wide:
        loads_strict("[1,2]", limits=JsonLimits(max_container_items=1))
    with pytest.raises(PlatformContractError) as string:
        loads_strict('"中文"', limits=JsonLimits(max_string_bytes=5))

    assert deep.value.code == "JSON_TOO_DEEP"
    assert wide.value.code == "CONTAINER_TOO_LARGE"
    assert string.value.code == "STRING_TOO_LARGE"


def test_canonical_json_rejects_non_json_python_values_and_non_finite_output() -> None:
    with pytest.raises(PlatformContractError) as unsupported:
        canonical_dumps({"bad": object()})
    with pytest.raises(PlatformContractError) as non_finite:
        canonical_dumps({"bad": float("nan")})
    with pytest.raises(PlatformContractError) as unsafe_float:
        canonical_dumps({"bad": 1e20})

    assert unsupported.value.code == "NOT_JSON"
    assert non_finite.value.code == "NON_FINITE_NUMBER"
    assert unsafe_float.value.code == "UNSAFE_INTEGER"
