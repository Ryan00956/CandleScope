param(
    [string]$FrontendUrl = "http://127.0.0.1:15287/",
    [int]$BackendPort = 18085,
    [string]$OutputPath = "../output/playwright/multi-chart-phase6/desktop-spike.json"
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $frontendRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot $OutputPath))
$previewUri = [Uri]$FrontendUrl
$previewPort = $previewUri.Port
$previewProcess = $null

try {
    $env:VITE_MULTI_CHART_16_ENABLED = "1"
    $env:VITE_MULTI_WINDOW_ENABLED = "1"
    $env:VITE_MULTI_CHART_64_ENABLED = "0"
    $env:VITE_CHART_WINDOW_BROKER_ENABLED = "1"
    $env:VITE_KLINE_BATCH_STREAM_ENABLED = "1"
    $env:VITE_API_BASE = "http://127.0.0.1:$BackendPort/api/v1"
    $env:VITE_DEV_PORT = [string]$previewPort
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Desktop spike frontend build failed" }

    $nodePath = (Get-Command node.exe).Source
    $vitePath = Join-Path $frontendRoot "node_modules/vite/bin/vite.js"
    $previewProcess = Start-Process `
        -FilePath $nodePath `
        -ArgumentList @($vitePath, "preview", "--host", "127.0.0.1", "--port", [string]$previewPort) `
        -WorkingDirectory $frontendRoot `
        -WindowStyle Hidden `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $response = $null
    do {
        try {
            $response = Invoke-WebRequest -Uri $FrontendUrl -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { break }
        } catch {
            Start-Sleep -Milliseconds 200
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $response -or $response.StatusCode -ne 200) {
        throw "Desktop spike preview did not become ready at $FrontendUrl"
    }

    $env:MULTI_WINDOW_ENABLED = "1"
    $env:CANDLESCOPE_DESKTOP_URL = $FrontendUrl
    $env:CANDLESCOPE_DESKTOP_BACKEND_PORT = [string]$BackendPort
    $env:CANDLESCOPE_DESKTOP_SPIKE_WINDOW_COUNT = "4"
    $env:CANDLESCOPE_DESKTOP_SPIKE_OUT = $resolvedOutput
    $env:CANDLESCOPE_DESKTOP_USER_DATA = Join-Path (Split-Path -Parent $resolvedOutput) "electron-user-data"
    $env:CANDLE_DB_PATH = Join-Path (Split-Path -Parent $resolvedOutput) "desktop-spike.db"
    & (Join-Path $frontendRoot "node_modules/.bin/electron.cmd") (Join-Path $frontendRoot "desktop/main.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Electron desktop spike failed with exit code $LASTEXITCODE" }

    $evidence = Get-Content -Raw -Encoding UTF8 -Path $resolvedOutput | ConvertFrom-Json
    if ($evidence.result -ne "pass") { throw "Desktop spike evidence reported $($evidence.result)" }
    $restoreOutput = Join-Path (Split-Path -Parent $resolvedOutput) "desktop-restore.json"
    Remove-Item Env:CANDLESCOPE_DESKTOP_SPIKE_OUT
    $env:CANDLESCOPE_DESKTOP_RESTORE_PROBE_OUT = $restoreOutput
    & (Join-Path $frontendRoot "node_modules/.bin/electron.cmd") (Join-Path $frontendRoot "desktop/main.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Electron desktop restore probe failed with exit code $LASTEXITCODE" }
    $restoreEvidence = Get-Content -Raw -Encoding UTF8 -Path $restoreOutput | ConvertFrom-Json
    if ($restoreEvidence.result -ne "pass" -or $restoreEvidence.probeMode -ne "restore") {
        throw "Desktop restore evidence reported $($restoreEvidence.result)"
    }
    Write-Output "DESKTOP_PHASE6_SPIKE_PASS $resolvedOutput"
} finally {
    if ($previewProcess -and -not $previewProcess.HasExited) {
        Stop-Process -Id $previewProcess.Id -Force
        $previewProcess.WaitForExit()
    }
}
