$ErrorActionPreference = "Stop"

$entrypoint = Join-Path $PSScriptRoot "drawing-rollback-drills-browser.mjs"
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
if ($null -eq $nodeCommand -or -not (Test-Path -LiteralPath $nodeCommand.Source -PathType Leaf)) {
    throw "A native node executable is required for the controlled rollback drills"
}

Get-ChildItem Env: | Where-Object { $_.Name -like "NODE_*" } | ForEach-Object {
    Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}

& $nodeCommand.Source $entrypoint @args
exit $LASTEXITCODE
