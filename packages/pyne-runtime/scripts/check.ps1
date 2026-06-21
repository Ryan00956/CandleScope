param(
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Python) {
    $VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
    if (Test-Path $VenvPython) {
        $Python = $VenvPython
    }
    else {
        $Python = "python"
    }
}

function Invoke-PyneCheck {
    param(
        [string[]]$Arguments
    )

    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $Python $($Arguments -join ' ')"
    }
}

Push-Location $Root
try {
    if ($env:PYNE_CHECK_TMP) {
        $CheckTmpRoot = $env:PYNE_CHECK_TMP
    }
    else {
        $CheckTmpRoot = Join-Path $Root ".pyne-check-tmp"
    }
    $RunId = "run-{0}-{1}" -f $PID, (Get-Date -Format "yyyyMMddHHmmssfff")
    $CheckTmp = Join-Path $CheckTmpRoot $RunId
    $PytestTemp = Join-Path $CheckTmp "pytest"
    $Dist = Join-Path $CheckTmp "dist"

    if (Test-Path $CheckTmpRoot) {
        Get-ChildItem -LiteralPath $CheckTmpRoot -Directory -Filter "run-*" -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
            ForEach-Object {
                try {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                }
                catch {
                    Write-Warning "Could not remove stale check temp directory '$($_.FullName)': $($_.Exception.Message)"
                }
            }
    }

    New-Item -ItemType Directory -Force -Path $PytestTemp | Out-Null
    $PreviousTemp = $env:TEMP
    $PreviousTmp = $env:TMP
    $env:TEMP = $CheckTmp
    $env:TMP = $CheckTmp

    Invoke-PyneCheck -Arguments @("-m", "ruff", "check", ".")
    Invoke-PyneCheck -Arguments @(
        "-m",
        "pytest",
        "-p",
        "no:cacheprovider",
        "--basetemp",
        (Join-Path $PytestTemp "run")
    )
    Invoke-PyneCheck -Arguments @("scripts/strategy_capture_scaffold.py", "--check")
    Invoke-PyneCheck -Arguments @(
        "scripts/strategy_capture_diff.py",
        "--assertion",
        "parity"
    )
    Invoke-PyneCheck -Arguments @(
        "scripts/ta_capture_diff.py",
        "--assertion",
        "parity"
    )
    Invoke-PyneCheck -Arguments @(
        "scripts/request_capture_diff.py",
        "--assertion",
        "parity"
    )
    if (Test-Path $Dist) {
        Remove-Item -LiteralPath $Dist -Recurse -Force
    }
    Invoke-PyneCheck -Arguments @("-m", "build", "--no-isolation", "--outdir", $Dist)
    $Artifacts = Get-ChildItem -LiteralPath $Dist | ForEach-Object { $_.FullName }
    $TwineArgs = @("-m", "twine", "check") + $Artifacts
    Invoke-PyneCheck -Arguments $TwineArgs
    Invoke-PyneCheck -Arguments @("scripts/package_smoke.py", "--dist-dir", $Dist, "--offline")
}
finally {
    if ($CheckTmp -and (Test-Path $CheckTmp)) {
        try {
            Remove-Item -LiteralPath $CheckTmp -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove check temp directory '$CheckTmp': $($_.Exception.Message)"
        }
    }
    if ($null -eq $PreviousTemp) {
        Remove-Item Env:\TEMP -ErrorAction SilentlyContinue
    }
    else {
        $env:TEMP = $PreviousTemp
    }
    if ($null -eq $PreviousTmp) {
        Remove-Item Env:\TMP -ErrorAction SilentlyContinue
    }
    else {
        $env:TMP = $PreviousTmp
    }
    Pop-Location
}
