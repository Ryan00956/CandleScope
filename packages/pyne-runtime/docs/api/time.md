# Time API

Pyne exposes the chart `time` series as a Pine-like object. It still behaves as
a series, so history references such as `time[1]` continue to work, and it also
provides helper methods under the same `time.*` surface.

```python
plot(time[1], "Previous Time")
plot(time.year(), "Year")
plot(time.hour(time, "+08:00"), "Hour In UTC+8")
```

Pyne accepts timestamp values in seconds. Millisecond timestamps are detected
when the absolute value is larger than `100_000_000_000`.

## Components

- `time.year(source=None, timezone="UTC")`
- `time.month(source=None, timezone="UTC")`
- `time.dayofmonth(source=None, timezone="UTC")`
- `time.dayofweek(source=None, timezone="UTC")`
- `time.hour(source=None, timezone="UTC")`
- `time.minute(source=None, timezone="UTC")`
- `time.second(source=None, timezone="UTC")`

When `source` is omitted, helpers use the chart `time` series. When `source` is
a series, helpers return a `PyneSeries`. When `source` is a scalar timestamp,
helpers return a scalar value.

`time.dayofweek()` follows Pine-style constants:

- `time.sunday`
- `time.monday`
- `time.tuesday`
- `time.wednesday`
- `time.thursday`
- `time.friday`
- `time.saturday`

## Construction And Formatting

- `time.timestamp(year, month, day, hour=0, minute=0, second=0, timezone="UTC")`
- `time.timestamp(timezone, year, month, day, hour=0, minute=0, second=0)`
- `time.format(source=None, fmt="%Y-%m-%d %H:%M:%S", timezone="UTC")`

`timezone` accepts `"UTC"`, fixed offsets such as `"+08:00"`, and IANA zone
names supported by Python's `zoneinfo`, such as `"America/New_York"`.

```python
stamp = time.timestamp(2024, 1, 2, 3, 4, 5)
shifted = time.timestamp("+08:00", 2024, 1, 2, 11, 4, 5)
label(time.format(stamp, "%Y-%m-%d %H:%M:%S"))
```
