# Data Model

Pyne accepts OHLCV bars:

```python
{
    "time": 1710000000,
    "open": 100.0,
    "high": 102.0,
    "low": 99.0,
    "close": 101.0,
    "volume": 1200.0,
}
```

Rules:

- `time` is a Unix timestamp in seconds.
- Price and volume fields are converted to floats.
- Data should be sorted by time before it is passed to Pyne.
- Hosts are responsible for adapting exchange/database formats into this contract.

`PyneData` is a lightweight wrapper around this standard shape.

