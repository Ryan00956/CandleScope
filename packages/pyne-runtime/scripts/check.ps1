param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Push-Location $Root
try {
    & $Python -m ruff check .
    & $Python -m pytest
    $Dist = Join-Path $env:TEMP "pyne-runtime-dist-check"
    if (Test-Path $Dist) {
        Remove-Item -LiteralPath $Dist -Recurse -Force
    }
    & $Python -m build --outdir $Dist
    & $Python -m twine check (Join-Path $Dist "*")
}
finally {
    Pop-Location
}
