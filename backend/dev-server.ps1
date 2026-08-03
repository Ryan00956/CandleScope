[CmdletBinding()]
param(
    [switch]$Watch
)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw "CandleScope backend virtual environment is missing: $venvPython"
}

# Uvicorn 0.34 switches Windows reload workers to SelectorEventLoop. CandleScope
# starts plugin sidecars with asyncio subprocesses, which require ProactorEventLoop.
# In watch mode, watchfiles keeps Uvicorn itself single-process and sends it SIGINT
# before each restart, so FastAPI can run the normal sidecar shutdown path.
Push-Location $PSScriptRoot
try {
    if ($Watch) {
        # Use a relative executable here: watchfiles' Windows command parser does
        # not strip quotes from an absolute executable path containing spaces.
        $watchCommand = ".\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18080"
        Write-Host "[dev] Watching $PSScriptRoot\app for Python changes; restart with Ctrl+C."
        & $venvPython -m watchfiles `
            --filter python `
            --sigint-timeout 20 `
            --target-type command `
            $watchCommand `
            (Join-Path $PSScriptRoot "app")
    }
    else {
        & $venvPython -m uvicorn app.main:app --host 127.0.0.1 --port 18080
    }
}
finally {
    Pop-Location
}
