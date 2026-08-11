param(
    [int]$BackendPort = 18090,
    [long]$DurationMs = 30000,
    [int]$SampleMs = 5000,
    [string]$SymbolsEvidence = "../output/playwright/multi-chart-phase8/desktop-phase8-w3.json",
    [string]$OutputPath = "../docs/perf-baselines/multi-chart-workspace/phase8-package-fresh-process-20260807.json"
)

$ErrorActionPreference = "Stop"
$frontendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $frontendRoot
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot $OutputPath))
$outputDirectory = Join-Path $repoRoot "output/playwright/multi-chart-phase8/package"
$sourceDatabase = Join-Path $repoRoot "backend/data/candlescope.db"
$sourceSymbolCatalog = Join-Path $repoRoot "backend/data/symbol_catalog.v1.json"
$runId = [Guid]::NewGuid().ToString("N")
$packageOutput = Join-Path ([System.IO.Path]::GetTempPath()) "candlescope-phase8-package-$runId"
$packageRoot = Join-Path $packageOutput "win-unpacked"
$executable = Join-Path $packageRoot "CandleScope.exe"
$electronDist = Join-Path $frontendRoot "node_modules/electron/dist"
$rawEvidence = @()
$resolvedSymbolsEvidence = [System.IO.Path]::GetFullPath((Join-Path $frontendRoot $SymbolsEvidence))

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
if (-not (Test-Path -LiteralPath $sourceDatabase)) {
    throw "Phase 8 package requires the frozen warm database at $sourceDatabase"
}
if (-not (Test-Path -LiteralPath $sourceSymbolCatalog)) {
    throw "Phase 8 package requires the frozen symbol catalog at $sourceSymbolCatalog"
}
if (-not (Test-Path -LiteralPath $resolvedSymbolsEvidence)) {
    throw "Phase 8 package requires passing W3 symbol evidence at $resolvedSymbolsEvidence"
}
$symbolEvidence = Get-Content -Raw -Encoding UTF8 -Path $resolvedSymbolsEvidence | ConvertFrom-Json
if ($symbolEvidence.result -ne "pass" -or $symbolEvidence.setup.symbols.Count -ne 64) {
    throw "Phase 8 package symbol evidence is not a passing 64-symbol W3 result"
}
$symbolCatalog = Get-Content -Raw -Encoding UTF8 -Path $sourceSymbolCatalog | ConvertFrom-Json
$spotMarket = @($symbolCatalog.markets | Where-Object {
    $_.exchange -eq "binance" -and $_.market_type -eq "spot"
})
if ($spotMarket.Count -ne 1) { throw "Frozen symbol catalog must contain one Binance spot market" }
$replacementSymbols = @($spotMarket[0].symbols | Where-Object {
    $_.active -and $_.quoteAsset -eq "USDT" -and $_.symbol
} | ForEach-Object { [string]$_.symbol })
$candidateSymbols = @(@($symbolEvidence.setup.symbols) + $replacementSymbols | Select-Object -Unique | Select-Object -First 128)
if ($candidateSymbols.Count -lt 64) { throw "Phase 8 package requires at least 64 frozen symbol candidates" }
$pinnedSymbolsJson = ConvertTo-Json -Compress -InputObject $candidateSymbols

$env:VITE_DESKTOP_BUILD = "1"
$env:VITE_MULTI_CHART_16_ENABLED = "1"
$env:VITE_MULTI_WINDOW_ENABLED = "1"
$env:VITE_MULTI_CHART_64_ENABLED = "1"
$env:VITE_CHART_WINDOW_BROKER_ENABLED = "1"
$env:VITE_KLINE_BATCH_STREAM_ENABLED = "1"
$env:VITE_API_BASE = "http://127.0.0.1:$BackendPort/api/v1"
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Phase 8 packaged frontend build failed" }

$packageBuilt = $false
for ($attempt = 1; $attempt -le 3 -and -not $packageBuilt; $attempt += 1) {
    & npx.cmd electron-builder --win dir `
        "--config.directories.output=$packageOutput" `
        "--config.electronDist=$electronDist"
    if ($LASTEXITCODE -eq 0) {
        $packageBuilt = $true
        break
    }
    $temporary = Join-Path $packageOutput "win-unpacked.tmp"
    if (Test-Path -LiteralPath $temporary) {
        $abandoned = Join-Path $packageOutput ("win-unpacked.abandoned-" + [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff"))
        Move-Item -LiteralPath $temporary -Destination $abandoned
    }
    Start-Sleep -Milliseconds (500 * $attempt)
}
if (-not $packageBuilt) { throw "Phase 8 unpacked package build failed after three bounded attempts" }
if (-not (Test-Path -LiteralPath $executable)) { throw "Missing packaged executable at $executable" }

for ($run = 1; $run -le 2; $run += 1) {
    $dataDirectory = Join-Path $outputDirectory "data-$runId-$run"
    $database = Join-Path $dataDirectory "candlescope.db"
    $evidencePath = Join-Path $outputDirectory "desktop-phase8-package-$runId-$run.json"
    $stdoutPath = Join-Path $outputDirectory "desktop-phase8-package-$runId-$run.stdout.log"
    $stderrPath = Join-Path $outputDirectory "desktop-phase8-package-$runId-$run.stderr.log"
    New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
    Copy-Item -LiteralPath $sourceDatabase -Destination $database
    Copy-Item -LiteralPath $sourceSymbolCatalog -Destination (Join-Path $dataDirectory "symbol_catalog.v1.json")
    foreach ($suffix in @("-wal", "-shm")) {
        $sourceSidecar = "$sourceDatabase$suffix"
        if (Test-Path -LiteralPath $sourceSidecar) {
            Copy-Item -LiteralPath $sourceSidecar -Destination "$database$suffix"
        }
    }
    Remove-Item Env:CANDLESCOPE_DESKTOP_URL -ErrorAction SilentlyContinue
    $env:MULTI_WINDOW_ENABLED = "1"
    $env:KLINE_BATCH_STREAM_ENABLED = "1"
    $env:CANDLESCOPE_DESKTOP_BACKEND_PORT = [string]$BackendPort
    $env:CANDLESCOPE_DESKTOP_PHASE8_OUT = $evidencePath
    $env:CANDLESCOPE_DESKTOP_PHASE8_MODE = "W3"
    $env:CANDLESCOPE_DESKTOP_PHASE8_DURATION_MS = [string]$DurationMs
    $env:CANDLESCOPE_DESKTOP_PHASE8_SAMPLE_MS = [string]$SampleMs
    $env:CANDLESCOPE_DESKTOP_PHASE8_READY_TIMEOUT_MS = "180000"
    $env:CANDLESCOPE_DESKTOP_PHASE8_SYMBOLS_JSON = $pinnedSymbolsJson
    $env:CANDLESCOPE_DESKTOP_USER_DATA = Join-Path $outputDirectory "electron-user-data-$runId-$run"
    $env:CANDLE_DATA_DIR = $dataDirectory
    $env:KLINES_DB_PATH = $database
    $packagedProcess = Start-Process `
        -FilePath $executable `
        -WorkingDirectory $packageRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru `
        -Wait
    if ($packagedProcess.ExitCode -ne 0) {
        $errorDetails = @()
        if (Test-Path -LiteralPath $stderrPath) {
            $stderrContent = Get-Content -Raw -Encoding UTF8 -LiteralPath $stderrPath
            if ($null -ne $stderrContent -and $stderrContent.Trim()) {
                $errorDetails += "stderr: $($stderrContent.Trim())"
            }
        }
        $startupErrorPath = Join-Path $env:CANDLESCOPE_DESKTOP_USER_DATA "logs/desktop-startup-error.log"
        if (Test-Path -LiteralPath $startupErrorPath) {
            $startupError = Get-Content -Raw -Encoding UTF8 -LiteralPath $startupErrorPath
            if ($null -ne $startupError -and $startupError.Trim()) {
                $errorDetails += "startup: $($startupError.Trim())"
            }
        }
        if ($errorDetails.Count -eq 0) { $errorDetails += "no stderr or startup log was captured" }
        throw "Packaged fresh process $run failed with exit code $($packagedProcess.ExitCode): $($errorDetails -join ' | ')"
    }
    $evidence = Get-Content -Raw -Encoding UTF8 -Path $evidencePath | ConvertFrom-Json
    if ($evidence.result -ne "pass" -or -not $evidence.environment.packaged) {
        throw "Packaged fresh process $run reported $($evidence.result)"
    }
    $rawEvidence += $evidencePath
}

& node.exe (Join-Path $PSScriptRoot "phase8-package-release.mjs") `
    --first $rawEvidence[0] `
    --second $rawEvidence[1] `
    --package-root $packageRoot `
    --out $resolvedOutput
if ($LASTEXITCODE -ne 0) { throw "Phase 8 package aggregate failed" }
Write-Output "DESKTOP_PHASE8_PACKAGE_PASS $resolvedOutput"
