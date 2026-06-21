# CandleScope Vendored Pyne Runtime

This directory is a vendored snapshot of the standalone Pyne runtime used by
CandleScope.

- Upstream repository: `git@github.com:Ryan00956/pyne-runtime.git`
- Snapshot source path: `H:\program\pyne-runtime`
- Snapshot source commit: `8452708`

## Update Flow

1. Finish and validate changes in `H:\program\pyne-runtime`.
2. Sync the source tree into `H:\program\CandleScope\packages\pyne-runtime`,
   excluding upstream-local folders such as `.git`, `.venv`, `.pytest_cache`,
   `.ruff_cache`, `.pyne-check-tmp`, and `.tmp`.
3. Run the Pyne package tests from the CandleScope backend venv:

```powershell
cd H:\program\CandleScope\backend
$env:PYTHONPATH = "H:\program\CandleScope\packages\pyne-runtime\src"
.\.venv\Scripts\python.exe -m pytest ..\packages\pyne-runtime\tests -q
```

4. Run CandleScope indicator integration tests without Pyne override variables:

```powershell
cd H:\program\CandleScope\backend
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
Remove-Item Env:CANDLESCOPE_PYNE_RUNTIME_SRC -ErrorAction SilentlyContinue
.\.venv\Scripts\python.exe -m pytest tests\test_indicator_api.py -q
```

5. Commit the vendor update and CandleScope integration changes separately
   when practical.
