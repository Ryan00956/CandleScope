param(
    [string]$FrontendUrl = "http://127.0.0.1:15290/?capacityProbe=phase8",
    [int]$BackendPort = 18089,
    [string]$OutputPath = "../docs/perf-baselines/multi-chart-workspace/phase8-flag-rollback-20260807.json"
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $frontendRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot $OutputPath))
$outputDirectory = Join-Path $repoRoot "output/playwright/multi-chart-phase8/rollback"
$runId = [Guid]::NewGuid().ToString("N")
$userDataDirectory = Join-Path $outputDirectory "electron-user-data-$runId"
$runDataDirectory = Join-Path $outputDirectory "data-$runId"
$sourceDatabase = Join-Path $repoRoot "backend/data/candlescope.db"
$isolatedDatabase = Join-Path $runDataDirectory "candlescope.db"
$previewPort = ([Uri]$FrontendUrl).Port
$nodePath = (Get-Command node.exe).Source
$vitePath = Join-Path $frontendRoot "node_modules/vite/bin/vite.js"
$electronPath = Join-Path $frontendRoot "node_modules/.bin/electron.cmd"
$stageOutputs = @{}

New-Item -ItemType Directory -Force -Path $outputDirectory, $runDataDirectory | Out-Null
if (-not (Test-Path -LiteralPath $sourceDatabase)) {
    throw "Phase 8 rollback requires the frozen warm database at $sourceDatabase"
}
Copy-Item -LiteralPath $sourceDatabase -Destination $isolatedDatabase
foreach ($suffix in @("-wal", "-shm")) {
    $sourceSidecar = "$sourceDatabase$suffix"
    if (Test-Path -LiteralPath $sourceSidecar) {
        Copy-Item -LiteralPath $sourceSidecar -Destination "$isolatedDatabase$suffix"
    }
}

foreach ($stage in @("64", "16", "4")) {
    $previewProcess = $null
    try {
        $multi16 = if ($stage -in @("64", "16")) { "1" } else { "0" }
        $multiWindow = if ($stage -eq "64") { "1" } else { "0" }
        $multi64 = if ($stage -eq "64") { "1" } else { "0" }
        $broker = if ($stage -in @("64", "16")) { "1" } else { "0" }
        $batch = if ($stage -in @("64", "16")) { "1" } else { "0" }
        $stageOutput = Join-Path $outputDirectory "desktop-phase8-rollback-$stage-$runId.json"
        $stageOutputs[$stage] = $stageOutput

        $env:VITE_MULTI_CHART_16_ENABLED = $multi16
        $env:VITE_MULTI_WINDOW_ENABLED = $multiWindow
        $env:VITE_MULTI_CHART_64_ENABLED = $multi64
        $env:VITE_CHART_WINDOW_BROKER_ENABLED = $broker
        $env:VITE_KLINE_BATCH_STREAM_ENABLED = $batch
        $env:KLINE_BATCH_STREAM_ENABLED = $batch
        $env:VITE_API_BASE = "http://127.0.0.1:$BackendPort/api/v1"
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Phase 8 rollback stage $stage frontend build failed" }

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
            throw "Phase 8 rollback preview did not become ready for stage $stage"
        }

        $env:MULTI_WINDOW_ENABLED = $multiWindow
        $env:CANDLESCOPE_DESKTOP_URL = $FrontendUrl
        $env:CANDLESCOPE_DESKTOP_BACKEND_PORT = [string]$BackendPort
        $env:CANDLESCOPE_DESKTOP_PHASE8_OUT = $stageOutput
        $env:CANDLESCOPE_DESKTOP_PHASE8_MODE = "ROLLBACK"
        $env:CANDLESCOPE_DESKTOP_PHASE8_ROLLBACK_STAGE = $stage
        $env:CANDLESCOPE_DESKTOP_ROLLBACK_MULTI16 = $multi16
        $env:CANDLESCOPE_DESKTOP_ROLLBACK_MULTI64 = $multi64
        $env:CANDLESCOPE_DESKTOP_ROLLBACK_BROKER = $broker
        $env:CANDLESCOPE_DESKTOP_ROLLBACK_BATCH = $batch
        $env:CANDLESCOPE_DESKTOP_USER_DATA = $userDataDirectory
        $env:CANDLE_DATA_DIR = $runDataDirectory
        $env:KLINES_DB_PATH = $isolatedDatabase
        & $electronPath (Join-Path $frontendRoot "desktop/main.mjs")
        if ($LASTEXITCODE -ne 0) { throw "Phase 8 rollback stage $stage failed with exit code $LASTEXITCODE" }
        $stageEvidence = Get-Content -Raw -Encoding UTF8 -Path $stageOutput | ConvertFrom-Json
        if ($stageEvidence.result -ne "pass") { throw "Phase 8 rollback stage $stage reported $($stageEvidence.result)" }
    } finally {
        if ($previewProcess -and -not $previewProcess.HasExited) {
            Stop-Process -Id $previewProcess.Id -Force
            $previewProcess.WaitForExit()
        }
    }
}

& node.exe (Join-Path $PSScriptRoot "phase8-flag-rollback.mjs") `
    --stage64 $stageOutputs["64"] `
    --stage16 $stageOutputs["16"] `
    --stage4 $stageOutputs["4"] `
    --out $resolvedOutput
if ($LASTEXITCODE -ne 0) { throw "Phase 8 rollback aggregate failed" }
Write-Output "DESKTOP_PHASE8_ROLLBACK_PASS $resolvedOutput"
