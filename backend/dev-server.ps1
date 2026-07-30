$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw "CandleScope backend virtual environment is missing: $venvPython"
}

# Uvicorn 0.34 switches Windows reload workers to SelectorEventLoop. CandleScope
# starts plugin sidecars with asyncio subprocesses, which require ProactorEventLoop.
& $venvPython -m uvicorn app.main:app --host 127.0.0.1 --port 18080
