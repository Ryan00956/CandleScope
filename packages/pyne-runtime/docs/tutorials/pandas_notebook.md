# Tutorial: Pandas And Notebooks

Pandas support is optional:

```bash
python -m pip install "pyne-runtime[pandas]"
```

Convert a DataFrame into Pyne data:

```python
import pyne_runtime as pn

data = pn.from_pandas(df)
result = pn.run('plot(close, "Close")', data)
```

Convert result lines into a DataFrame:

```python
frame = result.to_frame()
```

`result.to_frame()` requires the `pandas` optional dependency.

