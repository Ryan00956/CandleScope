# Command Line Interface

Pyne Runtime installs the `pyne` command.

The same CLI is also available with:

```bash
python -m pyne_runtime --version
```

## Run

```bash
pyne run examples/ma_cross.py --ohlcv examples/sample_ohlcv.csv --out result.json
```

Parameter overrides can be passed one at a time:

```bash
pyne run examples/ma_cross.py --ohlcv examples/sample_ohlcv.csv --param Length=20 --param Enabled=true
```

Values are parsed as JSON when possible, so `true`, `false`, `null`, numbers, arrays, and objects keep their JSON types. Other values are kept as strings.

For automation, pass a JSON object directly or provide a path to a JSON file:

```bash
pyne run examples/ma_cross.py --ohlcv examples/sample_ohlcv.csv --params-json params.json
```

## Validate

```bash
pyne validate examples/ma_cross.py
```

Validation checks Python syntax and the configured Pyne security policy.

## Schema

```bash
pyne schema
```

The schema command prints the public input and output contracts.
