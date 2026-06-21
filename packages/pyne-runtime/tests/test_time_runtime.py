from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {
            "time": 1704164645,  # 2024-01-02 03:04:05 UTC, Tuesday
            "open": 1,
            "high": 2,
            "low": 1,
            "close": 1.5,
            "volume": 100,
        },
        {
            "time": 1704254706,  # 2024-01-03 04:05:06 UTC, Wednesday
            "open": 2,
            "high": 3,
            "low": 1,
            "close": 2.5,
            "volume": 120,
        },
    ]


def test_time_namespace_preserves_series_history_and_adds_components() -> None:
    result = pn.run(
        """
plot(time[1], "Previous Time")
plot(time.year(), "Year")
plot(time.month(), "Month")
plot(time.dayofmonth(), "Day")
plot(time.dayofweek(), "Day Of Week")
plot(time.hour(), "Hour")
plot(time.minute(), "Minute")
plot(time.second(), "Second")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Previous Time") == [1704164645.0]
    assert result.values("Year") == [2024.0, 2024.0]
    assert result.values("Month") == [1.0, 1.0]
    assert result.values("Day") == [2.0, 3.0]
    assert result.values("Day Of Week") == [3.0, 4.0]
    assert result.values("Hour") == [3.0, 4.0]
    assert result.values("Minute") == [4.0, 5.0]
    assert result.values("Second") == [5.0, 6.0]


def test_time_helpers_accept_explicit_source_and_timezone() -> None:
    result = pn.run(
        """
stamp = time.timestamp(2024, 1, 2, 3, 4, 5)
shifted = time.timestamp(2024, 1, 2, 11, 4, 5, timezone="+08:00")
label(time.format(stamp, "%Y-%m-%d %H:%M:%S"))
label(time.format(stamp, "%H:%M", timezone="+08:00"))

plot(stamp, "Timestamp")
plot(shifted, "Shifted")
plot(time.hour(stamp, "+08:00"), "Shanghai Hour")
plot(1 if time.dayofweek(stamp) == time.tuesday else 0, "Constant Match")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "2024-01-02 03:04:05",
        "11:04",
    ]
    assert result.values("Timestamp") == [1704164645.0, 1704164645.0]
    assert result.values("Shifted") == [1704164645.0, 1704164645.0]
    assert result.values("Shanghai Hour") == [11.0, 11.0]
    assert result.values("Constant Match") == [1.0, 1.0]


def test_time_timestamp_accepts_timezone_first_pine_like_order() -> None:
    result = pn.run(
        """
keyword = time.timestamp(2024, 1, 2, 11, 4, 5, timezone="+08:00")
positional = time.timestamp("+08:00", 2024, 1, 2, 11, 4, 5)
legacy_positional = time.timestamp(2024, 1, 2, 11, 4, 5, "+08:00")
date_only = time.timestamp("UTC", 2024, 1, 2)
plot(keyword, "Keyword")
plot(positional, "Positional")
plot(legacy_positional, "Legacy Positional")
plot(date_only, "Date Only")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Keyword") == [1704164645.0, 1704164645.0]
    assert result.values("Positional") == [1704164645.0, 1704164645.0]
    assert result.values("Legacy Positional") == [1704164645.0, 1704164645.0]
    assert result.values("Date Only") == [1704153600.0, 1704153600.0]


def test_time_components_accept_millisecond_timestamps() -> None:
    result = pn.run(
        """
plot(time.year(1704164645000), "Year")
plot(time.second(1704164645000), "Second")
label(time.format(1704164645000, "%Y-%m-%d"))
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Year") == [2024.0, 2024.0]
    assert result.values("Second") == [5.0, 5.0]
    assert result.output["labels"][0]["text"] == "2024-01-02"
