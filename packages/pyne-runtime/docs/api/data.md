# PyneData

`PyneData` is a lightweight OHLCV container.

Create it from Python objects:

```python
data = pn.PyneData.from_ohlcv(items)
```

Create it from CSV:

```python
data = pn.read_ohlcv("bars.csv")
```

Create it from Pandas:

```python
data = pn.from_pandas(df)
```

Methods:

- `to_ohlcv()`
- `to_pandas()`

