# OpenClaw 一键部署 - 打包脚本
# 生成 exe、压缩包，并将 Shell 脚本一并放入发布文件夹

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetDir = Join-Path $root "src-tauri\target\release"
$bundleDir = Join-Path $targetDir "bundle"
$releaseDir = Join-Path $root "release"
$pkg = Get-Content (Join-Path $root "package.json") | ConvertFrom-Json
$ver = $pkg.version
$zipName = "OpenClaw-Deploy-v$ver-Windows.zip"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " OpenClaw 一键部署 - 打包发布" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 构建
Write-Host "[1/4] 正在构建 Tauri 应用..." -ForegroundColor Yellow
Set-Location $root
npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "构建失败" -ForegroundColor Red
    exit 1
}

# 2. 创建 release 文件夹
Write-Host "[2/4] 准备发布文件夹..." -ForegroundColor Yellow
if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $releaseDir | Out-Null

# 3. 复制文件
Write-Host "[3/4] 复制 exe、安装包、Shell 脚本..." -ForegroundColor Yellow

# exe
$exePath = Join-Path $targetDir "openclaw-deploy.exe"
if (Test-Path $exePath) {
    Copy-Item $exePath $releaseDir
    Write-Host "  - openclaw-deploy.exe" -ForegroundColor Green
}

# NSIS 安装包
$nsisDir = Join-Path $bundleDir "nsis"
if (Test-Path $nsisDir) {
    $nsisExe = Get-ChildItem $nsisDir -Filter "*.exe" | Select-Object -First 1
    if ($nsisExe) {
        Copy-Item $nsisExe.FullName (Join-Path $releaseDir $nsisExe.Name)
        Write-Host "  - $($nsisExe.Name)" -ForegroundColor Green
    }
}

# MSI 安装包
$msiDir = Join-Path $bundleDir "msi"
if (Test-Path $msiDir) {
    $msiFile = Get-ChildItem $msiDir -Filter "*.msi" | Select-Object -First 1
    if ($msiFile) {
        Copy-Item $msiFile.FullName (Join-Path $releaseDir $msiFile.Name)
        Write-Host "  - $($msiFile.Name)" -ForegroundColor Green
    }
}

# Shell 脚本
$shellScript = Join-Path $root "scripts\OpenClaw_Shell_Install.cmd"
if (Test-Path $shellScript) {
    Copy-Item $shellScript $releaseDir
    Write-Host "  - OpenClaw_Shell_Install.cmd" -ForegroundColor Green
}

# 使用文档
$docPath = Join-Path $root "使用文档.md"
if (Test-Path $docPath) {
    Copy-Item $docPath $releaseDir
    Write-Host "  - 使用文档.md" -ForegroundColor Green
}

# 4. 打压缩包
Write-Host "[4/4] 创建压缩包..." -ForegroundColor Yellow
$zipPath = Join-Path $root $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$releaseDir\*" -DestinationPath $zipPath -Force
Write-Host "  - $zipName" -ForegroundColor Green

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 打包完成" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "发布文件夹: $releaseDir"
Write-Host "压缩包: $zipPath"
Write-Host ""
