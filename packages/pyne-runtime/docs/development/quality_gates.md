# Quality Gates

Pyne Runtime is intended to be developed and tested as an independent package.

## Local Setup

From the repository root:

```bash
python -m pip install -e packages/pyne-runtime[dev]
```

Or from `packages/pyne-runtime`:

```bash
python -m pip install -e .[dev]
```

## Required Checks

Run these before committing package changes:

```bash
python -m ruff check packages/pyne-runtime
python -m pytest packages/pyne-runtime/tests
```

From the package root, the full package check also verifies build metadata:

```bash
scripts/check.ps1
```

On POSIX shells:

```bash
scripts/check.sh
```

The build output is written to a temporary directory, so the package tree stays clean.

## Independence Check

Package code must not import CandleScope application modules. This should return no matches:

```bash
Select-String -Path packages/pyne-runtime/src/pyne_runtime/*.py -Pattern 'from app\.|import app\.|app\.'
```

## Release Readiness

A release candidate is ready only when:

- package tests pass in a clean virtual environment;
- CLI smoke tests pass with `pyne run`, `pyne validate`, `pyne schema`, and `pyne --version`;
- `python -m build` creates both wheel and source distribution;
- `python -m twine check` passes for built artifacts;
- documentation and changelog reflect public API changes.
