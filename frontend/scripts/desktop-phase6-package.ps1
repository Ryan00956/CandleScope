param(
    [int]$BackendPort = 18086,
    [string]$OutputPath = "../output/playwright/multi-chart-phase6/desktop-packaged.json"
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot $OutputPath))

$env:VITE_DESKTOP_BUILD = "1"
$env:VITE_MULTI_CHART_16_ENABLED = "1"
$env:VITE_MULTI_WINDOW_ENABLED = "1"
$env:VITE_MULTI_CHART_64_ENABLED = "0"
$env:VITE_CHART_WINDOW_BROKER_ENABLED = "1"
$env:VITE_KLINE_BATCH_STREAM_ENABLED = "1"
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Packaged desktop frontend build failed" }

& npx.cmd electron-builder --win dir
if ($LASTEXITCODE -ne 0) {
    $packageRoot = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot "desktop-dist"))
    $temporary = [System.IO.Path]::GetFullPath((Join-Path $packageRoot "win-unpacked.tmp"))
    if ((Test-Path $temporary) -and $temporary.StartsWith($packageRoot + [System.IO.Path]::DirectorySeparatorChar)) {
        $abandoned = Join-Path $packageRoot ("win-unpacked.abandoned-" + [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff"))
        Move-Item -LiteralPath $temporary -Destination $abandoned
        Start-Sleep -Milliseconds 500
        & npx.cmd electron-builder --win dir
    }
}
if ($LASTEXITCODE -ne 0) { throw "Electron unpacked directory build failed after one bounded retry" }

$executable = Join-Path $frontendRoot "desktop-dist/win-unpacked/CandleScope.exe"
if (-not (Test-Path $executable)) { throw "Packaged executable was not produced at $executable" }

$env:MULTI_WINDOW_ENABLED = "1"
$env:CANDLESCOPE_DESKTOP_BACKEND_PORT = [string]$BackendPort
$env:CANDLESCOPE_DESKTOP_SPIKE_WINDOW_COUNT = "4"
$env:CANDLESCOPE_DESKTOP_SPIKE_OUT = $resolvedOutput
$env:CANDLESCOPE_DESKTOP_USER_DATA = Join-Path (Split-Path -Parent $resolvedOutput) "electron-packaged-user-data"
$env:CANDLE_DB_PATH = Join-Path (Split-Path -Parent $resolvedOutput) "desktop-packaged.db"
& $executable
if ($LASTEXITCODE -ne 0) { throw "Packaged CandleScope spike failed with exit code $LASTEXITCODE" }

$evidence = Get-Content -Raw -Encoding UTF8 -Path $resolvedOutput | ConvertFrom-Json
if ($evidence.result -ne "pass" -or -not $evidence.shell.packaged) {
    throw "Packaged desktop evidence reported $($evidence.result)"
}
Write-Output "DESKTOP_PHASE6_PACKAGE_PASS $resolvedOutput"
