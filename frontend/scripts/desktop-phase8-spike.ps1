param(
    [string]$FrontendUrl = "http://127.0.0.1:15289/?capacityProbe=phase8",
    [int]$BackendPort = 18088,
    [ValidateSet("W3", "F1", "F2", "F3", "SOAK")]
    [string]$Mode = "W3",
    [long]$DurationMs = 60000,
    [int]$SampleMs = 5000,
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $frontendRoot
$effectiveOutputPath = if ($OutputPath) {
    $OutputPath
} else {
    "../output/playwright/multi-chart-phase8/desktop-phase8-$($Mode.ToLowerInvariant()).json"
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
    if (-not (Test-Path -LiteralPath $sourceDatabase)) {
        throw "Phase 8 requires the frozen warm database at $sourceDatabase"
    }
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
    if ($LASTEXITCODE -ne 0) { throw "Phase 8 frontend build failed" }

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
        throw "Phase 8 preview did not become ready at $FrontendUrl"
    }

    $env:MULTI_WINDOW_ENABLED = "1"
    $env:CANDLESCOPE_DESKTOP_URL = $FrontendUrl
    $env:CANDLESCOPE_DESKTOP_BACKEND_PORT = [string]$BackendPort
    $env:CANDLESCOPE_DESKTOP_PHASE8_OUT = $resolvedOutput
    $env:CANDLESCOPE_DESKTOP_PHASE8_MODE = $Mode
    $env:CANDLESCOPE_DESKTOP_PHASE8_DURATION_MS = [string]$DurationMs
    $env:CANDLESCOPE_DESKTOP_PHASE8_SAMPLE_MS = [string]$SampleMs
    $env:CANDLESCOPE_DESKTOP_USER_DATA = Join-Path $outputDirectory "electron-user-data-$runId"
    $env:CANDLE_DATA_DIR = $runDataDirectory
    $env:KLINES_DB_PATH = $isolatedDatabase
    & (Join-Path $frontendRoot "node_modules/.bin/electron.cmd") (Join-Path $frontendRoot "desktop/main.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Electron Phase 8 $Mode probe failed with exit code $LASTEXITCODE" }

    $evidence = Get-Content -Raw -Encoding UTF8 -Path $resolvedOutput | ConvertFrom-Json
    if ($evidence.result -eq "fail") { throw "Phase 8 $Mode evidence reported fail" }
    Write-Output "DESKTOP_PHASE8_SPIKE_$($evidence.result.ToUpperInvariant().Replace('-', '_')) $resolvedOutput"
} finally {
    if ($previewProcess -and -not $previewProcess.HasExited) {
        Stop-Process -Id $previewProcess.Id -Force
        $previewProcess.WaitForExit()
    }
}
