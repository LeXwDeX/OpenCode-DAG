# ============================================================
#  OpenCode 0.0.4 升级脚本
#  用法：退出当前 opencode 后，在 PowerShell 中运行本脚本
# ============================================================
$ErrorActionPreference = "Stop"

$newBinary = "D:\agents_multi-orchestration\consult\opencode\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
$targetBinary = "C:\Users\SunTao\AppData\Roaming\npm\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe"
$backupBinary = "$targetBinary.0.0.3.bak"

Write-Host ""
Write-Host "=== OpenCode 0.0.4 升级 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 opencode 是否还在运行
$procs = Get-Process -Name "opencode" -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "[!] opencode 进程仍在运行 (PID: $($procs.Id -join ', '))" -ForegroundColor Yellow
    Write-Host "    请先退出 opencode，然后重新运行本脚本。" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# 2. 备份旧版本
if (Test-Path $targetBinary) {
    Write-Host "[1/3] 备份旧版本 -> opencode.exe.0.0.3.bak" -ForegroundColor Gray
    Copy-Item $targetBinary $backupBinary -Force
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[1/3] 未找到旧版本，跳过备份" -ForegroundColor Yellow
}

# 3. 复制新版本
Write-Host "[2/3] 复制新版本 0.0.4 ..." -ForegroundColor Gray
Copy-Item $newBinary $targetBinary -Force
Write-Host "  OK" -ForegroundColor Green

# 4. 验证
Write-Host "[3/3] 验证 ..." -ForegroundColor Gray
$ver = & $targetBinary --version 2>&1
if ($ver -match "0.0.4") {
    Write-Host "  opencode --version => $ver" -ForegroundColor Green
    Write-Host ""
    Write-Host "升级完成！你现在可以运行 opencode 了。" -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host "  版本号不符预期: $ver" -ForegroundColor Red
    Write-Host "  备份文件在: $backupBinary" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
