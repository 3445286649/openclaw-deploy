# 云睿OpenClaw - Windows 打包脚本
# 生成 exe、安装包、压缩包，并将 Shell 脚本一并放入发布文件夹

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetDir = Join-Path $root "src-tauri\target\release"
$bundleDir = Join-Path $targetDir "bundle"
$releaseDir = Join-Path $root "release"
$pkg = Get-Content (Join-Path $root "package.json") | ConvertFrom-Json
$ver = $pkg.version
$zipName = "Yunrui-OpenClaw-v$ver-Windows.zip"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 云睿OpenClaw - Windows 打包发布" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 构建
Write-Host "[1/4] 检查构建环境并构建 Tauri 应用..." -ForegroundColor Yellow
Set-Location $root

function Test-CommandExists($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    return $null -ne $cmd
}

if (-not (Test-CommandExists "node")) {
    Write-Host "缺少 Node.js。请先安装 Node.js 22 LTS 或更高版本。" -ForegroundColor Red
    exit 1
}
if (-not (Test-CommandExists "npm")) {
    Write-Host "缺少 npm。请确认 Node.js 安装完整。" -ForegroundColor Red
    exit 1
}
if (-not (Test-CommandExists "cargo")) {
    Write-Host "缺少 Rust/Cargo。请先安装 Rust stable：https://www.rust-lang.org/tools/install" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "未发现 node_modules，正在执行 npm ci..." -ForegroundColor Yellow
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm ci 失败，请检查网络或 package-lock.json。" -ForegroundColor Red
        exit 1
    }
}

$prepareBundled = Join-Path $root "scripts\prepare-bundled-extensions.ps1"
if (Test-Path $prepareBundled) {
    & $prepareBundled
}
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
$exePath = Join-Path $targetDir "yunrui-openclaw.exe"
if (-not (Test-Path $exePath)) {
    $exePath = Join-Path $targetDir "openclaw-deploy.exe"
}
if (Test-Path $exePath) {
    $targetExeName = "Yunrui-OpenClaw.exe"
    Copy-Item $exePath (Join-Path $releaseDir $targetExeName)
    Write-Host "  - $targetExeName" -ForegroundColor Green
} else {
    Write-Host "  ! 未找到主程序 exe：$exePath" -ForegroundColor Yellow
}

# NSIS 安装包
$nsisDir = Join-Path $bundleDir "nsis"
if (Test-Path $nsisDir) {
    $nsisExe = Get-ChildItem $nsisDir -Filter "*.exe" |
        Where-Object { $_.Name -like "*_${ver}_*" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $nsisExe) {
        $nsisExe = Get-ChildItem $nsisDir -Filter "*.exe" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
    }
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

# Shell 脚本（确保 OpenClaw_Shell.ps1 有 UTF-8 BOM，否则中文会乱码）
$ensureBom = Join-Path $root "scripts\ensure-utf8bom.ps1"
if (Test-Path $ensureBom) {
    & $ensureBom | Out-Null
}
$shellScript = Join-Path $root "scripts\OpenClaw_Shell_Install.cmd"
if (Test-Path $shellScript) {
    Copy-Item $shellScript $releaseDir
    Write-Host "  - OpenClaw_Shell_Install.cmd" -ForegroundColor Green
}
$installOnly = Join-Path $root "scripts\OpenClaw_Install_Only.ps1"
if (Test-Path $installOnly) {
    Copy-Item $installOnly $releaseDir
    Write-Host "  - OpenClaw_Install_Only.ps1" -ForegroundColor Green
}
$shellPs1 = Join-Path $root "scripts\OpenClaw_Shell.ps1"
if (Test-Path $shellPs1) {
    Copy-Item $shellPs1 $releaseDir
    Write-Host "  - OpenClaw_Shell.ps1" -ForegroundColor Green
}
$shellBootstrap = Join-Path $root "scripts\OpenClaw_Shell_Bootstrap.ps1"
if (Test-Path $shellBootstrap) {
    Copy-Item $shellBootstrap $releaseDir
    Write-Host "  - OpenClaw_Shell_Bootstrap.ps1" -ForegroundColor Green
}
# Linux/macOS Shell
$shellSh = Join-Path $root "scripts\OpenClaw_Shell.sh"
if (Test-Path $shellSh) {
    Copy-Item $shellSh $releaseDir
    Write-Host "  - OpenClaw_Shell.sh (Linux/macOS)" -ForegroundColor Green
}

# 使用文档（显式指定，避免拿错其他 md）
$docFile = Join-Path $root "使用文档.md"
if (Test-Path $docFile) {
    Copy-Item $docFile (Join-Path $releaseDir "使用文档.md") -Force
    Write-Host "  - 使用文档.md" -ForegroundColor Green
}
$yunruiDocFile = Join-Path $root "云睿OpenClaw发布说明.md"
if (Test-Path $yunruiDocFile) {
    Copy-Item $yunruiDocFile (Join-Path $releaseDir "云睿OpenClaw发布说明.md") -Force
    Write-Host "  - 云睿OpenClaw发布说明.md" -ForegroundColor Green
}
$checklistFile = Join-Path $root "RELEASE_CHECKLIST.md"
if (Test-Path $checklistFile) {
    Copy-Item $checklistFile (Join-Path $releaseDir "RELEASE_CHECKLIST.md") -Force
    Write-Host "  - RELEASE_CHECKLIST.md" -ForegroundColor Green
}
$actionsDocFile = Join-Path $root "GITHUB_ACTIONS_WINDOWS.md"
if (Test-Path $actionsDocFile) {
    Copy-Item $actionsDocFile (Join-Path $releaseDir "GITHUB_ACTIONS_WINDOWS.md") -Force
    Write-Host "  - GITHUB_ACTIONS_WINDOWS.md" -ForegroundColor Green
}
$commitSummaryFile = Join-Path $root "YUNRUI_COMMIT_SUMMARY.md"
if (Test-Path $commitSummaryFile) {
    Copy-Item $commitSummaryFile (Join-Path $releaseDir "YUNRUI_COMMIT_SUMMARY.md") -Force
    Write-Host "  - YUNRUI_COMMIT_SUMMARY.md" -ForegroundColor Green
}
$licenseFile = Join-Path $root "LICENSE"
if (Test-Path $licenseFile) {
    Copy-Item $licenseFile (Join-Path $releaseDir "LICENSE") -Force
    Write-Host "  - LICENSE" -ForegroundColor Green
}

# 4. 打压缩包
Write-Host "[4/4] 创建压缩包..." -ForegroundColor Yellow
$zipPath = Join-Path $root $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$releaseItems = Get-ChildItem $releaseDir -Force -ErrorAction SilentlyContinue
if (-not $releaseItems) {
    Write-Host "release 文件夹为空，打包终止。请检查 Tauri 构建产物。" -ForegroundColor Red
    exit 1
}
Compress-Archive -Path "$releaseDir\*" -DestinationPath $zipPath -Force
Write-Host "  - $zipName" -ForegroundColor Green

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " 打包完成" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "发布文件夹: $releaseDir"
Write-Host "压缩包: $zipPath"
Write-Host ""
