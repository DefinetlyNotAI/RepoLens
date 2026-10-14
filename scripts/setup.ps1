param([switch]$SkipTui)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    Write-Host 'RepoLens | Python environment' -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath '.venv')) {
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
    }
    & '.\.venv\Scripts\python.exe' -m pip install -e .
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
    if (-not $SkipTui) {
        Push-Location 'tui'
        try {
            Write-Host 'RepoLens | Terminal interface' -ForegroundColor Cyan
            npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw 'Terminal dependency installation failed' }
            npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Terminal build failed' }
        } finally { Pop-Location }
    }
    Write-Host 'Ready: .\.venv\Scripts\repolens.exe tui <repository>' -ForegroundColor Green
} finally { Pop-Location }
