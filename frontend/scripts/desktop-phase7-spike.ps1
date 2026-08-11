param(
    [string]$FrontendUrl = "http://127.0.0.1:15288/?capacityProbe=phase7",
    [int]$BackendPort = 18087,
    [ValidateSet("W1", "W2")]
    [string]$Scenario = "W1",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $frontendRoot
$effectiveOutputPath = if ($OutputPath) {
    $OutputPath
} else {
    "../output/playwright/multi-chart-phase7/desktop-phase7-$($Scenario.ToLowerInvariant()).json"
}
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot $effectiveOutputPath))
$previewUri = [Uri]$FrontendUrl
$previewPort = $previewUri.Port
$previewProcess = $null
$runId = [Guid]::NewGuid().ToString("N")
$outputDirectory = Split-Path -Parent $resolvedOutput
$runDataDirectory = Join-Path $outputDirectory "data-$runId"
$sourceDatabase = Join-Path $repoRoot "backend/data/candlescope.db"
$sourceSymbolCatalog = Join-Path $repoRoot "backend/data/symbol_catalog.v1.json"
$isolatedDatabase = Join-Path $runDataDirectory "candlescope.db"

try {
    New-Item -ItemType Directory -Force -Path $runDataDirectory | Out-Null
    Copy-Item -LiteralPath $sourceDatabase -Destination $isolatedDatabase
    if (Test-Path -LiteralPath $sourceSymbolCatalog) {
        Copy-Item -LiteralPath $sourceSymbolCatalog -Destination (Join-Path $runDataDirectory "symbol_catalog.v1.json")
    }
    foreach ($suffix in @("-wal", "-shm")) {
        $sourceSidecar = "$sourceDatabase$suffix"
        if (Test-Path -LiteralPath $sourceSidecar) {
            Copy-Item -LiteralPath $sourceSidecar -Destination "$isolatedDatabase$suffix"
        }
    }
    $env:VITE_MULTI_CHART_16_ENABLED = "1"
    $env:VITE_MULTI_WINDOW_ENABLED = "1"
    $env:VITE_MULTI_CHART_64_ENABLED = "1"
    $env:VITE_CHART_WINDOW_BROKER_ENABLED = "1"
    $env:VITE_KLINE_BATCH_STREAM_ENABLED = "1"
    $env:KLINE_BATCH_STREAM_ENABLED = "1"
    $env:VITE_API_BASE = "http://127.0.0.1:$BackendPort/api/v1"
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Phase 7 frontend build failed" }

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
        throw "Phase 7 preview did not become ready at $FrontendUrl"
    }

    $env:MULTI_WINDOW_ENABLED = "1"
    $env:CANDLESCOPE_DESKTOP_URL = $FrontendUrl
    $env:CANDLESCOPE_DESKTOP_BACKEND_PORT = [string]$BackendPort
    $env:CANDLESCOPE_DESKTOP_PHASE7_OUT = $resolvedOutput
    $env:CANDLESCOPE_DESKTOP_PHASE7_SCENARIO = $Scenario
    $env:CANDLESCOPE_DESKTOP_USER_DATA = Join-Path $outputDirectory "electron-user-data-$runId"
    $env:CANDLE_DATA_DIR = $runDataDirectory
    $env:KLINES_DB_PATH = $isolatedDatabase
    & (Join-Path $frontendRoot "node_modules/.bin/electron.cmd") (Join-Path $frontendRoot "desktop/main.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Electron Phase 7 probe failed with exit code $LASTEXITCODE" }

    $evidence = Get-Content -Raw -Encoding UTF8 -Path $resolvedOutput | ConvertFrom-Json
    if ($evidence.result -ne "pass") { throw "Phase 7 evidence reported $($evidence.result)" }
    Write-Output "DESKTOP_PHASE7_SPIKE_PASS $resolvedOutput"
} finally {
    if ($previewProcess -and -not $previewProcess.HasExited) {
        Stop-Process -Id $previewProcess.Id -Force
        $previewProcess.WaitForExit()
    }
}
