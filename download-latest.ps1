# =============================================================================
# download-latest.ps1 — Windows 下载最新 opencode 二进制（本仓库 fork）
#
# 行为：
#   - 上游：github.com/LeXwDeX/opencode（本仓库 fork）
#   - 目标目录：<repo>\packages\opencode\<tag>\（而非 ~\.opencode\bin）
#   - 自动挑选 Windows x64 baseline 资产（兼容无 AVX2 的老 CPU）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\download-latest.ps1
#   powershell -ExecutionPolicy Bypass -File .\download-latest.ps1 -Force
#   powershell -ExecutionPolicy Bypass -File .\download-latest.ps1 -TargetBinary "opencode-windows-x64.zip"
#
# 参数：
#   -TargetBinary : 资产文件名；默认 opencode-windows-x64-baseline.zip
#   -Force        : 已存在则覆盖
#   -Repo         : 覆盖仓库（默认 LeXwDeX/opencode）
# =============================================================================

[CmdletBinding()]
param(
    [string]$TargetBinary,
    [switch]$Force,
    [string]$Repo = "LeXwDeX/opencode"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"

Write-Host "[1/4] Querying $ApiUrl"
$headers = @{ "User-Agent" = "download-latest.ps1" }
$release = Invoke-RestMethod -Uri $ApiUrl -Headers $headers

$latestTag = $release.tag_name
Write-Host "      latest: $latestTag"

if (-not $TargetBinary) { $TargetBinary = "opencode-windows-x64-baseline.zip" }
$asset = $release.assets | Where-Object { $_.name -eq $TargetBinary }
if (-not $asset) {
    Write-Error "Asset '$TargetBinary' not found in $latestTag. Available assets:`n$($release.assets.name -join "`n")"
}

$TargetDir = Join-Path $RepoRoot "packages\opencode\$latestTag"
$TargetExe = Join-Path $TargetDir "opencode.exe"

if ((Test-Path $TargetExe) -and -not $Force) {
    Write-Host "[ok] Already present: $TargetExe (use -Force to re-download)" -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

Write-Host "[2/4] Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 2)) MB)"
$tempDir = Join-Path $env:TEMP "opencode-download-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$zipPath = Join-Path $tempDir $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers

Write-Host "[3/4] Extracting"
Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
$extractedExe = Get-ChildItem -Path $tempDir -Filter "opencode.exe" -Recurse | Select-Object -First 1
if (-not $extractedExe) { Write-Error "opencode.exe not found in archive" }

Write-Host "[4/4] Installing to $TargetDir"
Copy-Item -Path $extractedExe.FullName -Destination $TargetExe -Force
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

$v = (& $TargetExe --version 2>$null | Select-Object -First 1).Trim()
Write-Host "[ok] Installed: $v" -ForegroundColor Green
Write-Host "     path: $TargetExe" -ForegroundColor Green

