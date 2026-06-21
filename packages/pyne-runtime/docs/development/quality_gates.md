# Quality Gates

Pyne Runtime is intended to be developed and tested as an independent package.

## Local Setup

From the repository root:

```bash
python -m pip install -e .[dev]
```

## Required Checks

Run these before committing package changes:

```bash
python -m compileall src tests -q
python -m ruff check .
python -m pytest tests/test_architecture.py -q
python -m pytest -q
python scripts/request_capture_diff.py --assertion parity
python scripts/strategy_capture_scaffold.py --check
python scripts/strategy_capture_diff.py --assertion parity
python scripts/ta_capture_diff.py --assertion parity
git diff --check
```

When the package is not installed in editable mode, set `PYTHONPATH=src` before
running pytest. On PowerShell from the repository root:

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m pytest -q
```

## Architecture Checks

Architecture guard tests live in `tests/test_architecture.py`. Run them directly when
moving modules or changing public package exports:

```bash
python -m pytest tests/test_architecture.py -q
```

These checks verify that:

- every name in `pyne_runtime.__all__` is importable;
- core package modules do not import host application modules such as `app` or
  `candlescope`;
- the internal `pyne_runtime` import graph has no static cycles;
- unusually large modules emit a warning for architecture review without failing
  the test suite.

Golden-style semantic fixtures live under `tests/golden/` and are exercised by
the normal pytest suite. Add or update a fixture when a Pine-like compatibility
claim depends on exact alignment or replay output, especially for
`request.security` gaps/lookahead alignment, lower-timeframe grouping, strategy
fills, and barstate flags.

The request capture gate protects TradingView-backed `request.security()`
evidence. Captured `parity` fixtures must stay at 0 diff with
`request_capture_diff.py --assertion parity`, and the HTF parity fixture is also
exercised by `tests/test_golden_request_security.py`.

The strategy capture gates protect the TradingView external-evidence workflow:
`strategy_capture_scaffold.py --check` ensures every strategy pine-equivalent
case keeps an `external_capture` contract. Captured TradingView data can be used
in two assertion modes: `reference` captures are preserved as external evidence
and inspected with `strategy_capture_diff.py --assertion reference` or
`strategy_capture_diff.py --assertion all`, while `parity` captures are expected
to match current Pyne output in the golden tests and the package quality gate.
Use `strategy_capture_diff.py --assertion all --summary` when you need a grouped
case/plot view of captured differences across both modes.

## Phase-Focused Checks

Use focused checks during architecture work, then finish with the full gate:

```bash
python -m pytest \
  tests/test_golden_strategy.py \
  tests/test_strategy_runtime.py \
  tests/test_incremental.py \
  -q
python -m pytest tests/test_request_security.py tests/test_golden_request_security.py -q
python -m pytest tests/test_plot_runtime.py tests/test_result.py -q
python -m pytest tests/test_input_runtime.py tests/test_examples.py -q
python -m pytest \
  tests/test_smoke.py \
  tests/test_api.py \
  tests/test_cli.py \
  tests/test_cli_contracts.py \
  -q
```

The architecture guard should be run whenever public exports, package layout,
or namespace assembly changes:

```bash
python -m pytest tests/test_architecture.py -q
```

From the package root, the full package check also verifies build metadata:

```bash
scripts/check.ps1
```

On POSIX shells:

```bash
scripts/check.sh
```

The full package check builds into a temporary directory, runs
`python -m twine check`, installs the built wheel into a temporary virtualenv,
verifies the installed `py.typed` marker, and exercises the installed CLI with
`pyne --version`, `pyne schema`, `pyne validate`, and `pyne run`.
The scripts use per-run subdirectories under the ignored `.pyne-check-tmp`
directory as their pytest/build temporary root so the gate does not depend on
system temp directory permissions or stale pytest cleanup artifacts. Set
`PYNE_CHECK_TMP=/path/to/tmp` to override that location.
They also build with `python -m build --no-isolation`, so install the dev
extras first with `python -m pip install -e .[dev]`.
The package smoke step uses `scripts/package_smoke.py --offline`, which installs
the just-built wheel with `--no-deps` inside a venv that can see local system
site packages; this keeps the gate runnable without package-index access while
still checking wheel contents, CLI entry points, schema output, and example
execution.

## Independence Check

Package code must not import CandleScope application modules. The architecture
tests enforce this with AST scanning. For a quick manual check, this should
return no matches:

```bash
Select-String -Path src/pyne_runtime/*.py -Pattern 'from app\.|import app\.|app\.'
```

## Release Readiness

The full release flow and versioning policy live in
[Release Process](../reference/release_process.md).

A release candidate is ready only when:

- package tests pass in a clean virtual environment;
- CLI smoke tests pass with `pyne run`, `pyne validate`, `pyne schema`, and `pyne --version`;
- `python -m build` creates both wheel and source distribution;
- `python -m twine check` passes for built artifacts;
- `python scripts/package_smoke.py --dist-dir <dist>` passes against the built wheel;
- documentation and changelog reflect public API changes.
