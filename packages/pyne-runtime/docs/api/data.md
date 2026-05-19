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
- `column(name)`
- `head(n=5)`
- `tail(n=5)`

Convenience properties:

- `columns`
- `first`
- `last`
- `time_range`

Column names can also be accessed with item syntax:

```python
closes = data["close"]
first_bar = data[0]
first_ten = data[:10]
```
