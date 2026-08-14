[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $PSScriptRoot "backend\data\local-data"),
    [string]$BackendPython = (Join-Path $PSScriptRoot "backend\.venv\Scripts\python.exe"),
    [ValidateRange(1024, 65535)]
    [int]$BackendPort = 18080,
    [ValidateRange(1024, 65535)]
    [int]$FrontendPort = 15173,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$backendDir = Join-Path $PSScriptRoot "backend"
$frontendDir = Join-Path $PSScriptRoot "frontend"
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
$viteEntrypoint = Join-Path $frontendDir "node_modules\vite\bin\vite.js"
$quotedViteEntrypoint = '"' + $viteEntrypoint + '"'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $BackendPython -PathType Leaf)) {
    throw "Backend Python is missing: $BackendPython"
}
if (-not (Test-Path -LiteralPath $viteEntrypoint -PathType Leaf)) {
    throw "Frontend dependencies are missing. Run npm install in $frontendDir"
}

$env:CANDLESCOPE_RUNTIME_MODE = "LOCAL_OFFLINE"
$env:CANDLESCOPE_LOCAL_DATA_DIR = $resolvedDataDir
$env:VITE_API_PROXY_TARGET = "http://127.0.0.1:$BackendPort"
$env:VITE_DEV_PORT = [string]$FrontendPort

$backendProcess = $null
$frontendProcess = $null
try {
    $backendProcess = Start-Process `
        -FilePath $BackendPython `
        -ArgumentList @(
            "-m", "uvicorn", "app.main:app",
            "--host", "127.0.0.1",
            "--port", [string]$BackendPort
        ) `
        -WorkingDirectory $backendDir `
        -WindowStyle Hidden `
        -PassThru

    $frontendProcess = Start-Process `
        -FilePath $nodeExecutable `
        -ArgumentList @(
            $quotedViteEntrypoint,
            "--host", "127.0.0.1",
            "--port", [string]$FrontendPort,
            "--strictPort"
        ) `
        -WorkingDirectory $frontendDir `
        -WindowStyle Hidden `
        -PassThru

    $healthUrl = "http://127.0.0.1:$BackendPort/health"
    $pageUrl = "http://127.0.0.1:$FrontendPort/local.html"
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    $ready = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($backendProcess.HasExited) {
            throw "The LOCAL_OFFLINE backend exited before becoming ready."
        }
        if ($frontendProcess.HasExited) {
            throw "The local frontend exited before becoming ready."
        }
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            $ready = $health.runtime_mode -eq "LOCAL_OFFLINE"
        }
        catch {
            $ready = $false
        }
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw "LOCAL_OFFLINE backend did not become ready within 30 seconds."
    }

    Write-Host "CandleScope LOCAL_OFFLINE is ready: $pageUrl"
    Write-Host "Data directory: $resolvedDataDir"
    Write-Host "Press Ctrl+C to stop both local processes."
    if (-not $NoBrowser) {
        Start-Process -FilePath $pageUrl
    }

    while (-not $backendProcess.HasExited -and -not $frontendProcess.HasExited) {
        Start-Sleep -Milliseconds 500
    }
    if ($backendProcess.HasExited) {
        throw "The LOCAL_OFFLINE backend stopped unexpectedly."
    }
    throw "The local frontend stopped unexpectedly."
}
finally {
    foreach ($taskProcess in @($frontendProcess, $backendProcess)) {
        if ($null -ne $taskProcess -and -not $taskProcess.HasExited) {
            Stop-Process -Id $taskProcess.Id -Force
        }
    }
}
