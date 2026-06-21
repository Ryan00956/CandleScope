from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]


def test_str_namespace_is_callable_and_formats_values() -> None:
    result = pn.run(
        """
label(str(123))
label(str.tostring(close, "#.##"))
label(str.tostring(true))
plot(str.tonumber("42.5"), "Number")
plot(str.length("hello"), "Length")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == ["123", "3.5", "true"]
    assert result.values("Number") == [42.5, 42.5, 42.5]
    assert result.values("Length") == [5.0, 5.0, 5.0]


def test_str_search_replace_case_and_substring_helpers() -> None:
    result = pn.run(
        """
text = " fast-slow-fast "
trimmed = str.trim(text)
label(str.upper(str.substring(trimmed, 0, 4)))
label(str.replace(trimmed, "fast", "ema", 1))
label(str.replace_all(trimmed, "fast", "ema"))

plot(str.pos(trimmed, "slow"), "Pos")
plot(str.contains(trimmed, "slow"), "Contains")
plot(str.startswith(trimmed, "fast"), "Starts")
plot(str.endswith(trimmed, "fast"), "Ends")
plot(str.length(str.lower("FAST")), "Lower Length")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "FAST",
        "fast-slow-ema",
        "ema-slow-ema",
    ]
    assert result.values("Pos") == [5.0, 5.0, 5.0]
    assert result.values("Contains") == [1.0, 1.0, 1.0]
    assert result.values("Starts") == [1.0, 1.0, 1.0]
    assert result.values("Ends") == [1.0, 1.0, 1.0]
    assert result.values("Lower Length") == [4.0, 4.0, 4.0]


def test_str_match_returns_first_regex_match_or_none() -> None:
    result = pn.run(
        """
label(str.match("NASDAQ:AAPL", "[A-Z]+$"))
label(str.match("close=123.45; volume=100", "[0-9]+[.][0-9]+"))
plot(str.tonumber(str.match("close=123.45", "[0-9]+[.][0-9]+")), "Matched Number")
plot(str.tonumber(str.match("no digits", "[0-9]+")), "Missing Match")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == ["AAPL", "123.45"]
    assert result.values("Matched Number") == [123.45, 123.45, 123.45]
    assert result.values("Missing Match") == []


def test_str_split_repeat_and_format_helpers_interoperate_with_arrays() -> None:
    result = pn.run(
        """
parts = str.split("ema,sma,rsi", ",")
label(array.join(parts, "|"))
label(str.repeat("x", 3))
label(str.format("{0}:{1}", "close", str.tostring(close, "#.0")))
plot(array.size(parts), "Parts")
plot(str.tonumber("not-a-number"), "Missing")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "ema|sma|rsi",
        "xxx",
        "close:3.5",
    ]
    assert result.values("Parts") == [3.0, 3.0, 3.0]
    assert result.values("Missing") == []
