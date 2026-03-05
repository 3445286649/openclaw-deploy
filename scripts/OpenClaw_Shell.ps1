# OpenClaw Shell - UTF-8 with BOM
param(
  [string]$Action = ""
)
$ErrorActionPreference = "Continue"
trap {
  Write-Host ""
  $errMsg = $_.Exception.Message
  Write-Host "`[Error`] $errMsg" -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}
$utf8 = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8
try { chcp 65001 | Out-Null } catch {}

$NPM_GLOBAL = "$env:APPDATA\npm"
# Ensure Node.js and npm in PATH (fix: npm not recognized when launched from shortcut/explorer)
try {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  if ($userPath -or $machinePath) { $env:PATH = "$userPath;$machinePath;$env:PATH" }
} catch {}
$nodePaths = @(
  "$env:ProgramFiles\nodejs",
  "${env:ProgramFiles(x86)}\nodejs",
  "$env:LOCALAPPDATA\Programs\node",
  "D:\nodejs", "C:\nodejs",
  $NPM_GLOBAL
)
foreach ($p in $nodePaths) {
  if ($p -and (Test-Path $p)) {
    $pNorm = $p.TrimEnd('\')
    $inPath = ($env:PATH -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') }) -contains $pNorm
    if (-not $inPath) { $env:PATH = "$p;$env:PATH" }
  }
}

# 最先检测 Node.js 和 Git，缺失则弹下载页并退出
$hasNode = Get-Command node -ErrorAction SilentlyContinue
$hasGit = Get-Command git -ErrorAction SilentlyContinue
if (-not $hasNode -or -not $hasGit) {
  Write-Host ""
  if (-not $hasNode) { Write-Host "[缺失] 未检测到 Node.js" -ForegroundColor Red }
  if (-not $hasGit) { Write-Host "[缺失] 未检测到 Git" -ForegroundColor Red }
  Write-Host ""
  if (-not $hasNode) {
    Write-Host "正在打开 Node.js 下载页..." -ForegroundColor Yellow
    try { Start-Process "https://nodejs.org/" } catch {}
  }
  if (-not $hasGit) {
    Write-Host "正在打开 Git 下载页..." -ForegroundColor Yellow
    try { Start-Process "https://git-scm.com/download/win" } catch {}
  }
  Write-Host ""
  Read-Host "安装完成后请重新运行脚本，按回车键退出"
  exit 1
}

# 配置路径：优先 OPENCLAW_STATE_DIR（与 OpenClaw 官方一致），其次 OPENCLAW_CONFIG / OPENCLAW_CONFIG_DIR，否则默认 ~/.openclaw
# 未设置时尝试从 gateway.cmd 自动检测（解决安装在其他盘时路径不一致）
function Get-DefaultOpenClawConfig {
  if ($env:OPENCLAW_STATE_DIR) { return $env:OPENCLAW_STATE_DIR.Trim().TrimEnd([char]92) }
  if ($env:OPENCLAW_CONFIG) { return $env:OPENCLAW_CONFIG.Trim().TrimEnd([char]92) }
  if ($env:OPENCLAW_CONFIG_DIR) { return $env:OPENCLAW_CONFIG_DIR.Trim().TrimEnd([char]92) }
  $defaultDir = "$env:USERPROFILE\.openclaw"
  $nestedDir = "$env:USERPROFILE\openclaw\.openclaw"
  foreach ($base in @($defaultDir, $nestedDir)) {
    $gwPath = Join-Path $base "gateway.cmd"
    if (-not (Test-Path $gwPath)) { continue }
    $content = [System.IO.File]::ReadAllText($gwPath)
    $detected = $null
    if ($content -match 'OPENCLAW_STATE_DIR\s*=\s*"([^"]+)"') {
      $detected = $Matches[1].Trim().TrimEnd([char]92)
    } elseif ($content -match 'OPENCLAW_STATE_DIR\s*=\s*(\S+)') {
      $detected = $Matches[1].Trim().TrimEnd([char]92).TrimEnd('"')
    }
    if ($detected -and (Test-Path (Join-Path $detected "openclaw.json"))) {
      return $detected
    }
  }
  return $defaultDir
}
$OPENCLAW_CONFIG = Get-DefaultOpenClawConfig

# 优先使用系统 PATH 中实际调用的 openclaw（支持一键部署的自定义安装目录）
# 注意：必须用 .cmd 而非 .ps1，否则 Start-Process 会打开编辑器而非执行
function Get-OpenClawPath {
  $cmd = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($cmd) {
    $src = $cmd.Source
    if ($src -match '\.ps1$') {
      $dir = Split-Path $src -Parent
      $cmdPath = Join-Path $dir "openclaw.cmd"
      if (Test-Path $cmdPath) { return $cmdPath }
    }
    if (Test-Path $src) { return $src }
  }
  return $null
}
# 扫描 PATH 等位置，查找实际存在的 openclaw.cmd（热迁移后旧路径可能已删除）
# 注意：不在此处调用 npm，否则会在 Ensure-OpenClaw 检测 node 之前就报错
function Find-ValidOpenClawPath {
  $dirsToCheck = @()
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $dirsToCheck += $userPath -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $dirsToCheck += $env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $dirsToCheck += $NPM_GLOBAL
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    $npmPrefix = (npm config get prefix 2>$null)
    if ($npmPrefix) { $dirsToCheck += $npmPrefix.Trim() }
  }
  # 桌面应用默认安装路径、热迁移常用路径
  $dirsToCheck += "$env:USERPROFILE\openclaw", "D:\openclow", "C:\openclow", "D:\openclaw", "C:\openclaw", "D:\openclaw1", "C:\openclaw1"
  $seen = @{}
  foreach ($dir in $dirsToCheck) {
    if (-not $dir) { continue }
    $dir = $dir.Trim().TrimEnd([char]92)
    if (-not $dir -or $seen[$dir]) { continue }
    $cmdPath = Join-Path $dir "openclaw.cmd"
    $ps1Path = Join-Path $dir "openclaw.ps1"
    if (Test-Path $cmdPath) { return $cmdPath }
    if (Test-Path $ps1Path) { return $ps1Path }
    $seen[$dir] = $true
  }
  return $null
}
$OPENCLAW_ACTUAL = Get-OpenClawPath
if ($OPENCLAW_ACTUAL -and (Test-Path $OPENCLAW_ACTUAL)) {
  $OPENCLAW_CMD = $OPENCLAW_ACTUAL
} else {
  $OPENCLAW_CMD = "$NPM_GLOBAL\openclaw.cmd"
  if (-not (Test-Path $OPENCLAW_CMD)) {
    $found = Find-ValidOpenClawPath
    if ($found) {
      $OPENCLAW_CMD = $found
      $ocDir = Split-Path $OPENCLAW_CMD -Parent
      $env:PATH = "$ocDir;$env:PATH"
    }
  }
}
if (-not (Test-Path $OPENCLAW_CMD)) {
  $env:PATH = "$NPM_GLOBAL;$env:PATH"
} else {
  $ocDir = Split-Path $OPENCLAW_CMD -Parent
  $env:PATH = "$ocDir;$env:PATH"
}

function Write-Header {
  Clear-Host
  Write-Host ""
  Write-Host "==========================================" -ForegroundColor Cyan
  Write-Host "  OpenClaw" -ForegroundColor Cyan
  Write-Host "==========================================" -ForegroundColor Cyan
  $ocDir = Split-Path $OPENCLAW_CMD -Parent
  Write-Host ("  路径: " + $ocDir) -ForegroundColor DarkGray
  $gwStatus = if (Test-GatewayRunning -UseCache) { 'Gateway: 运行中' } else { 'Gateway: 已停止' }
  Write-Host ("  " + $gwStatus) -ForegroundColor $(if (Test-GatewayRunning -UseCache) { "Green" } else { "DarkGray" })
  if (-not (Test-OpenClawPathInUserEnv)) {
    Write-Host ""
    Write-Host "  【重要】openclaw 未加入 PATH，cmd 中无法直接运行 openclaw" -ForegroundColor Yellow
    Write-Host "  请选择 [7] 配置路径 -> 一键添加 PATH，新开 cmd 后生效" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "  [1]  快速配置 - 首次使用 / 环境检测 / 配置 API" -ForegroundColor White
  Write-Host "  [2]  启动 Gateway - 后台运行控制面板服务" -ForegroundColor White
  Write-Host "  [3]  常用命令 - status / start / stop / restart 等" -ForegroundColor White
  Write-Host "  [4]  运行 OpenClaw - 直接进入 openclaw 命令行，可输入 status/gateway 等命令" -ForegroundColor White
  Write-Host "  [5]  检查更新 - 升级 OpenClaw 到最新版" -ForegroundColor White
  Write-Host "  [6]  打开对话界面 - Control UI 网页" -ForegroundColor White
  Write-Host "  [7]  配置路径 - 查看安装目录 / 添加 PATH" -ForegroundColor White
  Write-Host "  [8]  帮助与文档 - 打开官方文档" -ForegroundColor White
  Write-Host "  [9]  安装管理 - 嗅探 / 删除 / 热迁移" -ForegroundColor White
  Write-Host "  [10] 工具箱 - 备份 / 恢复 / 诊断 / 代理" -ForegroundColor White
  Write-Host "  [0]  退出" -ForegroundColor White
  Write-Host "==========================================" -ForegroundColor Cyan
  Write-Host ""
}

function Write-Submenu {
  Write-Host ""
  Write-Host "--- 常用命令 ---" -ForegroundColor Yellow
  Write-Host "  [1]  Gateway 状态 (gateway status)" -ForegroundColor White
  Write-Host "  [2]  启动 Gateway (start)" -ForegroundColor White
  Write-Host "  [3]  停止 Gateway (stop)" -ForegroundColor White
  Write-Host "  [4]  重启 Gateway (restart)" -ForegroundColor White
  Write-Host "  [5]  模型列表 (models list)" -ForegroundColor White
  Write-Host "  [6]  渠道状态 (channels status)" -ForegroundColor White
  Write-Host "  [7]  诊断检查 (doctor)" -ForegroundColor White
  Write-Host "  [8]  完整状态 (status)" -ForegroundColor White
  Write-Host "  [0]  返回主菜单" -ForegroundColor White
  Write-Host ""
}

function Ensure-OpenClaw {
  Write-Host ""
  Write-Host "`[第一页`] 环境检测" -ForegroundColor Yellow
  Write-Host "----------------------------------------"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "`[失败`] 未检测到 Node.js" -ForegroundColor Red
    return $false
  }
  $nodeVer = (node -v 2>$null)
  Write-Host ("`[OK`] Node.js " + $nodeVer) -ForegroundColor Green
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "`[失败`] 未检测到 npm" -ForegroundColor Red
    return $false
  }
  $npmVer = (npm -v 2>$null)
  Write-Host ("`[OK`] npm " + $npmVer) -ForegroundColor Green
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "`[警告`] 未检测到 Git。npm 安装 OpenClaw 时可能需要 Git，建议先安装: https://git-scm.com/download/win" -ForegroundColor Yellow
    Write-Host "  若安装失败并提示 spawn git，请安装 Git 后重试" -ForegroundColor DarkGray
  } else {
    Write-Host ("`[OK`] Git " + (git --version 2>$null)) -ForegroundColor Green
  }
  Write-Host ""

  Write-Host "`[第二页`] OpenClaw 安装检测" -ForegroundColor Yellow
  Write-Host "----------------------------------------"
  if (-not (Test-Path $OPENCLAW_CMD)) {
    Write-Host "未检测到 OpenClaw，跳转安装" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  请选择安装方式:" -ForegroundColor Cyan
    Write-Host "  [1]  直接安装 - 安装到 npm 全局目录 ($NPM_GLOBAL)" -ForegroundColor White
    Write-Host "  [2]  自定义目录 - 推荐，避免 AppData 权限/网络问题 (如 D:\openclow)" -ForegroundColor White
    Write-Host "  [0]  取消" -ForegroundColor White
    Write-Host ""
    $instChoice = Read-Host "请选择 (1/2/0)"
    $instChoice = if ($instChoice) { $instChoice.Trim() } else { "" }
    if ($instChoice -eq "0") {
      Write-Host "`[取消`] 已取消安装" -ForegroundColor DarkGray
      return $false
    }
    if ($instChoice -eq "2") {
      $customPath = Read-Host "输入安装目录 (如 D:\openclow)"
      $customPath = Sanitize-PathInput $customPath
      if (-not $customPath) {
        Write-Host "`[取消`] 未输入有效路径" -ForegroundColor Yellow
        return $false
      }
      $drive = Split-Path $customPath -Qualifier -ErrorAction SilentlyContinue
      if ($drive -and -not (Test-Path $drive)) {
        Write-Host ("`[失败`] 驱动器不存在: " + $drive) -ForegroundColor Red
        return $false
      }
      if (-not (Test-Path $customPath)) {
        try { New-Item -ItemType Directory -Path $customPath -Force | Out-Null } catch {
          Write-Host ("`[失败`] 无法创建目录: " + $customPath) -ForegroundColor Red
          return $false
        }
      }
      Write-Host ("正在安装到 " + $customPath + " ...") -ForegroundColor Cyan
      npm install -g openclaw --prefix $customPath
      if ($LASTEXITCODE -ne 0) {
        Write-Host "`[失败`] 安装失败" -ForegroundColor Red
        Write-Host "`[提示`] EPERM/权限: 关闭杀毒软件或以管理员身份运行" -ForegroundColor Yellow
        Write-Host "`[提示`] ECONNRESET/网络: 检查代理、防火墙，或稍后重试" -ForegroundColor Yellow
        return $false
      }
      $mjsCheck = Join-Path $customPath "node_modules\openclaw\openclaw.mjs"
      if (-not (Test-Path $mjsCheck)) {
        Write-Host "`[失败`] 安装不完整，未找到 openclaw.mjs" -ForegroundColor Red
        return $false
      }
      $script:OPENCLAW_CMD = if (Test-Path (Join-Path $customPath "openclaw.cmd")) {
        Join-Path $customPath "openclaw.cmd"
      } else {
        Join-Path $customPath "openclaw.ps1"
      }
      $env:PATH = "$customPath;$env:PATH"
      Update-UserPathForMigration -RemoveDir $null -AddDir $customPath
      Write-Host "`[完成`] OpenClaw 已安装到 $customPath" -ForegroundColor Green
    } else {
      if ($instChoice -ne "1") { Write-Host "默认使用直接安装" -ForegroundColor DarkGray }
      Write-Host "正在安装到 npm 全局目录..." -ForegroundColor Cyan
      npm install -g openclaw
      if ($LASTEXITCODE -ne 0) {
        Write-Host "`[失败`] 安装失败" -ForegroundColor Red
        Write-Host "`[提示`] EPERM/权限: 选择 [2] 自定义目录安装到 D:\openclow 可避免" -ForegroundColor Yellow
        Write-Host "`[提示`] ECONNRESET/网络: 检查代理、防火墙，或稍后重试" -ForegroundColor Yellow
        $ocDir = Join-Path $NPM_GLOBAL "node_modules\openclaw"
        if (Test-Path $ocDir) {
          $clean = Read-Host "是否清理失败残留后改用自定义目录安装? (y/N)"
          if ($clean -eq 'y' -or $clean -eq 'Y') {
            try {
              Remove-Item -Path $ocDir -Recurse -Force -ErrorAction Stop
              Write-Host "`[OK`] 已清理，请重新选择 [2] 自定义目录安装" -ForegroundColor Green
            } catch {
              Write-Host "`[提示`] 清理失败，请手动删除 $ocDir 后重试" -ForegroundColor Yellow
            }
          }
        }
        return $false
      }
      Write-Host "`[完成`] OpenClaw 已安装" -ForegroundColor Green
    }
  } else {
    Write-Host "`[完成`] OpenClaw 已安装" -ForegroundColor Green
    $ver = (& $OPENCLAW_CMD --version 2>$null)
    if ($ver) { Write-Host ("`[版本`] " + $ver) -ForegroundColor DarkGray }
  }
  if (-not (Test-OpenClawPathInUserEnv)) {
    $ocDir = Split-Path $OPENCLAW_CMD -Parent
    Write-Host ("`[提示`] " + $ocDir + " 未在 PATH 中，选项 7 可一键添加") -ForegroundColor Yellow
  }
  Write-Host ""
  return $true
}

function Run-OpenClaw {
  param([string]$CmdArgs)
  $cfgDir = Get-OpenClawConfigDir
  $prevState = $env:OPENCLAW_STATE_DIR
  try {
    $env:OPENCLAW_STATE_DIR = $cfgDir
    if ($CmdArgs) {
      $parts = $CmdArgs.Trim() -split ' +'
      & $OPENCLAW_CMD @parts
    } else {
      & $OPENCLAW_CMD
    }
    return $LASTEXITCODE
  } finally {
    if ($null -eq $prevState) { Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue }
    else { $env:OPENCLAW_STATE_DIR = $prevState }
  }
}

# 确保 gateway.mode 已设置（OpenClaw 2026+ 要求，否则 Gateway 会拒绝启动）
function Ensure-GatewayMode {
  $configDir = Get-OpenClawConfigDir
  $cfgPath = Join-Path $configDir "openclaw.json"
  if (-not (Test-Path $cfgPath)) { return }
  try {
    $raw = Read-FileUtf8 $cfgPath
    if (-not $raw -or $raw.Trim().Length -eq 0) { return }
    $json = $raw | ConvertFrom-Json
    $mode = $json.gateway.mode
    if ($mode -and $mode.ToString().Trim().Length -gt 0) { return }
    & $OPENCLAW_CMD config set gateway.mode local 2>$null | Out-Null
  } catch {}
}

# 后台启动 Gateway（无窗口，不阻塞）
# 优先用 schtasks 直接触发任务；任务不存在时先 install 再 run
function Start-Gateway-Hidden {
  $script:GatewayCacheTime = $null
  Ensure-GatewayMode
  $null = schtasks /query /tn "OpenClaw Gateway" 2>$null
  if ($LASTEXITCODE -eq 0) {
    schtasks /run /tn "OpenClaw Gateway" 2>$null | Out-Null
    return $true
  }
  try {
    $ocDir = Split-Path $OPENCLAW_CMD -Parent
    if (-not (Test-Path $OPENCLAW_CMD)) { return $false }
    $env:OPENCLAW_STATE_DIR = Get-OpenClawConfigDir
    & $OPENCLAW_CMD gateway install --force 2>$null | Out-Null
    Patch-GatewayCmdStateDir
    Start-Sleep -Seconds 1
    schtasks /run /tn "OpenClaw Gateway" 2>$null | Out-Null
    return $true
  } catch { return $false }
}

# 在 gateway.cmd 中注入 OPENCLAW_STATE_DIR，确保计划任务启动的 Gateway 使用正确配置目录
function Patch-GatewayCmdStateDir {
  $configDir = Get-OpenClawConfigDir
  $gwPath = Join-Path $configDir "gateway.cmd"
  if (-not (Test-Path $gwPath)) { return }
  $content = [System.IO.File]::ReadAllText($gwPath)
  if ($content -match 'OPENCLAW_STATE_DIR') { return }
  $stateDirEsc = $configDir.Replace('"', '""')
  $inject = "set `"OPENCLAW_STATE_DIR=$stateDirEsc`"`r`n"
  $newContent = $inject + $content
  if ($newContent -ne $content) {
    [System.IO.File]::WriteAllText($gwPath, $newContent, [System.Text.Encoding]::UTF8)
  }
}

# 修复 .openclaw/gateway.cmd：当指向已删除路径时，用当前 openclaw 重写，并注入 OPENCLAW_STATE_DIR
function Repair-GatewayCmdIfNeeded {
  $configDir = Get-OpenClawConfigDir
  $gwPath = Join-Path $configDir "gateway.cmd"
  if (-not (Test-Path $gwPath)) { return }
  $content = [System.IO.File]::ReadAllText($gwPath)
  if ($content -match '(\S+node\.exe)\s+(\S+)\s+gateway') {
    $indexJs = $Matches[2].Trim('"').Trim("'")
    if ($indexJs -notmatch 'openclaw.*index\.js$') { return }
    if (-not (Test-Path $indexJs)) {
      $ocDir = Split-Path $OPENCLAW_CMD -Parent
      $idxPath = Join-Path $ocDir "node_modules\openclaw\dist\index.js"
      if (-not (Test-Path $idxPath)) { $idxPath = Join-Path $NPM_GLOBAL "node_modules\openclaw\dist\index.js" }
      if ((Test-Path $idxPath) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $nodeExe = (Get-Command node).Source
        $cfg = Get-Content (Join-Path $configDir "openclaw.json") -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        $token = if ($cfg -and $cfg.gateway -and $cfg.gateway.auth -and $cfg.gateway.auth.token) { $cfg.gateway.auth.token } else { "" }
        $port = if ($cfg -and $cfg.gateway -and $cfg.gateway.port) { $cfg.gateway.port } else { "18789" }
        $stateDirEsc = $configDir.Replace('"', '""')
        $gwContent = "@echo off`r`nrem OpenClaw Gateway (repaired)`r`nset `"OPENCLAW_STATE_DIR=$stateDirEsc`"`r`nset `"OPENCLAW_GATEWAY_PORT=$port`"`r`n"
        if ($token) { $gwContent += "set `"OPENCLAW_GATEWAY_TOKEN=$token`"`r`n" }
        $gwContent += "`"$nodeExe`" `"$idxPath`" gateway --port $port`r`n"
        [System.IO.File]::WriteAllText($gwPath, $gwContent, [System.Text.Encoding]::UTF8)
      }
    }
  }
  Patch-GatewayCmdStateDir
}

# 直接启动 Gateway（无窗口，后台运行）
function Start-Gateway-Direct {
  Repair-GatewayCmdIfNeeded
  $ocDir = Split-Path $OPENCLAW_CMD -Parent
  $cfgDir = Get-OpenClawConfigDir
  if (-not (Test-Path $OPENCLAW_CMD)) { return $false }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c set `"OPENCLAW_STATE_DIR=$($cfgDir.Replace('"','""'))`" && `"$OPENCLAW_CMD`" gateway"
    $psi.WorkingDirectory = $ocDir
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    [void][System.Diagnostics.Process]::Start($psi)
    return $true
  } catch {
    try {
      $env:OPENCLAW_STATE_DIR = $cfgDir
      Start-Process -FilePath $OPENCLAW_CMD -ArgumentList "gateway" -WorkingDirectory $ocDir -WindowStyle Hidden
      return $true
    } catch { return $false }
  }
}

# 启动 Gateway 并等待就绪（直接执行 openclaw gateway，无弹窗）
function Start-Gateway-AndWait {
  param([int]$MaxWaitSec = 25)
  Ensure-GatewayMode
  $script:GatewayCacheTime = $null
  if (-not (Test-Path $OPENCLAW_CMD)) { return $false }
  Run-OpenClaw "gateway stop" 2>$null | Out-Null
  Start-Sleep -Seconds 2
  if (-not (Start-Gateway-Direct)) { return $false }
  Start-Sleep -Seconds 3
  return Wait-GatewayReady -MaxWaitSec $MaxWaitSec
}

function Get-GatewayToken {
  $configDir = Get-OpenClawConfigDir
  $cfgPath = Join-Path $configDir "openclaw.json"
  if (-not (Test-Path $cfgPath)) { return $null }
  try {
    $raw = Read-FileUtf8 $cfgPath
    if (-not $raw -or $raw.Trim().Length -eq 0) { return $null }
    $json = $raw | ConvertFrom-Json
    return $json.gateway.auth.token
  } catch { return $null }
}

# 一键嗅探：探测所有 OpenClaw 安装位置
function Get-OpenClawLocations {
  $found = [System.Collections.ArrayList]::new()
  $seen = @{}
  $currentDir = Split-Path $OPENCLAW_CMD -Parent
  $dirsToCheck = @()
  $cmd = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($cmd) {
    $dirsToCheck += Split-Path $cmd.Source -Parent
  }
  $dirsToCheck += $env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $dirsToCheck += $NPM_GLOBAL
  $npmPrefix = (npm config get prefix 2>$null)
  if ($npmPrefix) { $dirsToCheck += $npmPrefix.Trim() }
  $dirsToCheck += Join-Path $env:ProgramFiles "nodejs"
  foreach ($dir in $dirsToCheck) {
    if (-not $dir) { continue }
    $dir = $dir.Trim().TrimEnd([char]92)
    if (-not $dir -or $seen[$dir]) { continue }
    $cmdPath = Join-Path $dir "openclaw.cmd"
    $ps1Path = Join-Path $dir "openclaw.ps1"
    if ((Test-Path $cmdPath) -or (Test-Path $ps1Path)) {
      $seen[$dir] = $true
      $ver = $null
      $exe = if (Test-Path $cmdPath) { $cmdPath } else { $ps1Path }
      try { $ver = & $exe --version 2>$null } catch {}
      [void]$found.Add([PSCustomObject]@{ Path = $dir; Version = $ver; Current = ($dir -eq $currentDir) })
    }
  }
  return $found
}

# 安全读取 UTF-8 文件（避免 Get-Content 编码问题导致崩溃）
function Read-FileUtf8 {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return "" }
    $utf8 = [System.Text.Encoding]::UTF8
    return $utf8.GetString($bytes)
  } catch {
    return $null
  }
}

# 安全写入 UTF-8 文件
function Write-FileUtf8 {
  param([string]$Path, [string]$Content)
  try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
    return $true
  } catch { return $false }
}

# 检测 API 提供商是否已配置（读取 openclaw.json / auth-profiles.json）
function Test-ApiProviderConfigured {
  param([string]$Provider)
  $configDir = Get-OpenClawConfigDir
  $cfgPath = Join-Path $configDir "openclaw.json"
  $authPath = Join-Path $configDir "agents\main\agent\auth-profiles.json"
  $hasKey = $false
  if (Test-Path $cfgPath) {
    try {
      $raw = Read-FileUtf8 $cfgPath
      if ($raw -and $raw.Trim().Length -gt 0) {
        $json = $raw | ConvertFrom-Json
        $providers = $json.models.providers
        if ($providers) {
          $authProvider = switch ($Provider) {
            "anthropic" { "anthropic" }
            default { "openai" }
          }
          $p = $providers.$authProvider
          if ($p -and $p.apiKey -and $p.apiKey.ToString().Trim().Length -gt 0) { $hasKey = $true }
        }
      }
    } catch {}
  }
  if (-not $hasKey -and (Test-Path $authPath)) {
    try {
      $raw = Read-FileUtf8 $authPath
      if ($raw -and $raw.Trim().Length -gt 0) {
        $auth = $raw | ConvertFrom-Json
        $profiles = $auth.profiles
        if ($profiles) {
          $authProvider = switch ($Provider) {
            "anthropic" { "anthropic" }
            default { "openai" }
          }
          $profId = $authProvider + ":default"
          $prof = $profiles.PSObject.Properties[$profId].Value
          if ($prof -and $prof.key -and $prof.key.ToString().Trim().Length -gt 0) { $hasKey = $true }
        }
      }
    } catch {}
  }
  return $hasKey
}

# 获取配置目录（兜底：未定义时使用默认路径）
function Get-OpenClawConfigDir {
  if ($OPENCLAW_CONFIG -and $OPENCLAW_CONFIG.Trim().Length -gt 0) {
    return $OPENCLAW_CONFIG.Trim().TrimEnd([char]92)
  }
  return "$env:USERPROFILE\.openclaw"
}

# 加载渠道配置，返回 @{ Channels = $channels; ParseError = $err }
function Get-ChannelConfigData {
  $configDir = Get-OpenClawConfigDir
  $cfgPath = Join-Path $configDir "openclaw.json"
  $chPath = Join-Path $configDir "channels.json"
  $channels = $null
  $parseError = $null
  if (Test-Path $cfgPath) {
    try {
      $raw = Read-FileUtf8 $cfgPath
      if ($raw -and $raw.Trim().Length -gt 0) {
        $json = $raw | ConvertFrom-Json
        $channels = $json.channels
      }
    } catch {
      $parseError = "openclaw.json parse error"
    }
  }
  if (-not $channels -and (Test-Path $chPath)) {
    try {
      $raw = Read-FileUtf8 $chPath
      if ($raw -and $raw.Trim().Length -gt 0) {
        $chRoot = $raw | ConvertFrom-Json
        $channels = $chRoot
      }
    } catch {
      if (-not $parseError) { $parseError = "channels.json parse error" }
    }
  }
  return @{ Channels = $channels; ParseError = $parseError }
}

# 检测渠道是否已配置（支持多账号：飞书/钉钉检查任一有效账号）
function Test-ChannelConfigured {
  param([string]$ChannelId, [object]$ChannelsData = $null)
  if (-not $ChannelsData) { $ChannelsData = Get-ChannelConfigData }
  $channels = $ChannelsData.Channels
  if (-not $channels) { return $false }
  $ch = $channels.$ChannelId
  if (-not $ch) { return $false }
  $hasCred = $false
  switch ($ChannelId) {
    "telegram" { $hasCred = ($ch.botToken -and $ch.botToken.ToString().Trim().Length -gt 0) }
    "discord" { $t = $ch.token; if (-not $t) { $t = $ch.botToken }; $hasCred = ($t -and $t.ToString().Trim().Length -gt 0) }
    "feishu" {
      $accs = @($ch)
      if ($ch.accounts) {
        $accs = @()
        foreach ($k in $ch.accounts.PSObject.Properties.Name) { $accs += $ch.accounts.$k }
      }
      foreach ($acc in $accs) {
        if ($acc.appId -and $acc.appSecret -and $acc.appId.ToString().Trim().Length -gt 0 -and $acc.appSecret.ToString().Trim().Length -gt 0) {
          $hasCred = $true; break
        }
      }
    }
    "dingtalk" {
      $accs = @($ch)
      if ($ch.accounts) {
        $accs = @()
        foreach ($k in $ch.accounts.PSObject.Properties.Name) { $accs += $ch.accounts.$k }
      }
      foreach ($acc in $accs) {
        if ($acc.appKey -and $acc.appSecret -and $acc.appKey.ToString().Trim().Length -gt 0 -and $acc.appSecret.ToString().Trim().Length -gt 0) {
          $hasCred = $true; break
        }
      }
    }
    "qq" { $hasCred = (($ch.appId -and $ch.appId.ToString().Trim().Length -gt 0) -and (($ch.token -or $ch.appSecret) -and (($ch.token -or $ch.appSecret).ToString().Trim().Length -gt 0))) }
    default { return $false }
  }
  return $hasCred
}

# 获取渠道配置摘要（脱敏显示，如 Token 前4位、App ID 等）
function Get-ChannelConfigSummary {
  param([string]$ChannelId, [object]$ChannelsData = $null)
  if (-not $ChannelsData) { $ChannelsData = Get-ChannelConfigData }
  $channels = $ChannelsData.Channels
  if (-not $channels) { return "" }
  $ch = $channels.$ChannelId
  if (-not $ch) { return "" }
  $safeMask = {
    param($s)
    if ($null -eq $s) { return "***" }
    try { $str = $s.ToString() } catch { return "***" }
    if (-not $str -or $str.Length -lt 4) { return "***" }
    return $str.Substring(0, [Math]::Min(4, $str.Length)) + "***"
  }
  $safeMaskId = {
    param($s, $n)
    if ($null -eq $s) { return "" }
    try { $str = $s.ToString() } catch { return "" }
    if (-not $str -or $str.Length -eq 0) { return "" }
    return $str.Substring(0, [Math]::Min($n, $str.Length)) + "***"
  }
  switch ($ChannelId) {
    "telegram" { $t = $ch.botToken; return if ($t) { "Token: $(& $safeMask $t)" } else { "" } }
    "discord" { $t = $ch.token; if (-not $t) { $t = $ch.botToken }; return if ($t) { "Token: $(& $safeMask $t)" } else { "" } }
    "feishu" {
      $acc = $ch
      try { if ($ch.accounts -and $ch.accounts.main) { $acc = $ch.accounts.main } } catch {}
      if ($acc -and $acc.appId -and $acc.appSecret) { return "AppId: $(& $safeMaskId $acc.appId 8)" }
      return ""
    }
    "dingtalk" {
      $acc = $ch
      try { if ($ch.accounts -and $ch.accounts.main) { $acc = $ch.accounts.main } } catch {}
      if ($acc -and $acc.appKey -and $acc.appSecret) { return "AppKey: $(& $safeMaskId $acc.appKey 8)" }
      return ""
    }
    "qq" {
      if ($ch.appId) { return "AppId: $(& $safeMaskId $ch.appId 8)" }
      return ""
    }
    default { return "" }
  }
}

# 清除渠道配置（从 openclaw.json 和 channels.json 移除）
function Remove-ChannelConfig {
  param([string]$ChannelId)
  $configDir = Get-OpenClawConfigDir
  $cfgPath = Join-Path $configDir "openclaw.json"
  $chPath = Join-Path $configDir "channels.json"
  $modified = $false
  if (Test-Path $cfgPath) {
    try {
      $raw = Read-FileUtf8 $cfgPath
      if ($raw -and $raw.Trim().Length -gt 0) {
        $json = $raw | ConvertFrom-Json
        $chProp = $json.channels.PSObject.Properties[$ChannelId]
        if ($json.channels -and $chProp) {
          $json.channels.PSObject.Properties.Remove($chProp)
          $out = $json | ConvertTo-Json -Depth 20
          if ($out) { Write-FileUtf8 $cfgPath $out | Out-Null; $modified = $true }
        }
      }
    } catch {}
  }
  if (Test-Path $chPath) {
    try {
      $raw = Read-FileUtf8 $chPath
      if ($raw -and $raw.Trim().Length -gt 0) {
        $root = $raw | ConvertFrom-Json
        $chProp = $root.PSObject.Properties[$ChannelId]
        if ($chProp) {
          $root.PSObject.Properties.Remove($chProp)
          $out = $root | ConvertTo-Json -Depth 20
          if ($out) { Write-FileUtf8 $chPath $out | Out-Null; $modified = $true }
        }
      }
    } catch {}
  }
  return $modified
}

# 显示所有渠道状态（批量检查）
function Show-AllChannelStatus {
  try {
    $data = Get-ChannelConfigData
    if ($data.ParseError) {
      Write-Host ""
      Write-Host "[WARN] $($data.ParseError)" -ForegroundColor Yellow
      Write-Host ""
      return
    }
    $channels = @(
      @{ Id = "telegram"; Name = "Telegram" },
      @{ Id = "discord"; Name = "Discord" },
      @{ Id = "feishu"; Name = "Feishu" },
      @{ Id = "dingtalk"; Name = "DingTalk" },
      @{ Id = "qq"; Name = "QQ" }
    )
    Write-Host ""
    Write-Host "--- Channel Status ---" -ForegroundColor Yellow
    $cfgDir = Get-OpenClawConfigDir
    Write-Host "  Config: $cfgDir" -ForegroundColor DarkGray
    Write-Host ""
    foreach ($c in $channels) {
      try {
        $ok = Test-ChannelConfigured $c.Id $data
        $summary = ""
        if ($ok) {
          try { $summary = Get-ChannelConfigSummary $c.Id $data } catch {}
        }
        $status = if ($ok) { "OK" + $(if ($summary) { " ($summary)" } else { "" }) } else { "Not configured" }
        Write-Host "  $($c.Name): $status" -ForegroundColor $(if ($ok) { "Green" } else { "DarkGray" })
      } catch {
        Write-Host "  $($c.Name): Error" -ForegroundColor Red
      }
    }
    Write-Host ""
  } catch {
    Write-Host ""
    Write-Host "[ERROR] Channel status check failed" -ForegroundColor Red
    Write-Host ""
  }
}

# 接入对话渠道：先安装插件（如需），再配置 Token/配对码
function Invoke-ChannelSetup {
  $data = Get-ChannelConfigData
  if ($data.ParseError) {
    Write-Host ""
    Write-Host "`[警告`] $($data.ParseError)" -ForegroundColor Yellow
    Write-Host ""
  }
  $tgOk = Test-ChannelConfigured "telegram" $data
  $dcOk = Test-ChannelConfigured "discord" $data
  $fsOk = Test-ChannelConfigured "feishu" $data
  $dtOk = Test-ChannelConfigured "dingtalk" $data
  $qqOk = Test-ChannelConfigured "qq" $data

  Write-Host ""
  Write-Host "--- 接入对话渠道 ---" -ForegroundColor Yellow
  Write-Host "  选择要接入的平台（需插件会先一键安装）:" -ForegroundColor DarkGray
  Write-Host ("  [1] Telegram  - " + $(if ($tgOk) { "已配置 | 再次选择可重新配置/清除" } else { "需 Bot Token，与 @BotFather 创建" })) -ForegroundColor $(if ($tgOk) { "Green" } else { "White" })
  Write-Host ("  [2] Discord   - " + $(if ($dcOk) { "已配置 | 再次选择可重新配置/清除" } else { "需 Bot Token，Discord 开发者门户创建" })) -ForegroundColor $(if ($dcOk) { "Green" } else { "White" })
  Write-Host ("  [3] 飞书      - " + $(if ($fsOk) { "已配置 | 再次选择可重新配置/清除" } else { "需插件，App ID + App Secret" })) -ForegroundColor $(if ($fsOk) { "Green" } else { "White" })
  Write-Host ("  [4] 钉钉      - " + $(if ($dtOk) { "已配置 | 再次选择可重新配置/清除" } else { "需插件，AppKey + AppSecret" })) -ForegroundColor $(if ($dtOk) { "Green" } else { "White" })
  Write-Host ("  [5] QQ       - " + $(if ($qqOk) { "已配置 | 再次选择可重新配置/清除" } else { "需插件，QQ 开放平台 AppID + AppSecret" })) -ForegroundColor $(if ($qqOk) { "Green" } else { "White" })
  Write-Host "  [0] 返回" -ForegroundColor White
  Write-Host ""
  $ch = Read-Host "请选择"
  $ch = if ($ch) { $ch.Trim() } else { "" }
  if ($ch -eq "0") { return }

  $plugin = $null
  $channelName = ""
  $channelId = ""
  $alreadyOk = $false
  switch ($ch) {
    "1" { $channelName = "Telegram"; $channelId = "telegram"; $alreadyOk = $tgOk }
    "2" { $channelName = "Discord"; $channelId = "discord"; $alreadyOk = $dcOk }
    "3" { $plugin = "@openclaw/feishu"; $channelName = "飞书"; $channelId = "feishu"; $alreadyOk = $fsOk }
    "4" { $plugin = "@adongguo/openclaw-dingtalk"; $channelName = "钉钉"; $channelId = "dingtalk"; $alreadyOk = $dtOk }
    "5" { $plugin = "@sliverp/qqbot"; $channelName = "QQ"; $channelId = "qq"; $alreadyOk = $qqOk }
    default { Write-Host "`[无效`] 请输入 1-5 或 0" -ForegroundColor Yellow; return }
  }

  if ($alreadyOk) {
    Write-Host ""
    $summary = Get-ChannelConfigSummary $channelId $data
    if ($summary) { Write-Host "  当前配置摘要: $summary" -ForegroundColor DarkGray }
    Write-Host "  [1] 重新配置  [2] 清除配置  [0] 取消" -ForegroundColor Cyan
    $reconf = Read-Host "请选择"
    $reconf = if ($reconf) { $reconf.Trim() } else { "" }
    if ($reconf -eq "0") { return }
    if ($reconf -eq "2") {
      if (Remove-ChannelConfig $channelId) {
        Write-Host "`[OK`] $channelName 配置已清除" -ForegroundColor Green
      } else {
        Write-Host "`[提示`] 未找到可清除的配置" -ForegroundColor Yellow
      }
      Pause-Wait
      return
    }
    Write-Host "`[提示`] 将进入重新配置" -ForegroundColor Cyan
  }

  if ($plugin) {
    Write-Host ""
    Write-Host ("正在安装 $channelName 插件: $plugin ...") -ForegroundColor Cyan
    $env:OPENCLAW_STATE_DIR = Get-OpenClawConfigDir
    $plugErr = ""
    try { & $OPENCLAW_CMD plugins install "${plugin}@latest" 2>&1 | Tee-Object -Variable plugErr | Out-Null } catch { $plugErr = $_.Exception.Message }
    if ($LASTEXITCODE -ne 0) {
      Write-Host "`[失败`] 插件安装失败，请检查网络" -ForegroundColor Red
      Write-TicketSummary "渠道插件安装 ($channelName)" $plugErr | Out-Null
      Pause-Wait
      return
    }
    Ensure-ExtensionManifestCompat | Out-Null
    Write-Host "`[OK`] 插件已安装" -ForegroundColor Green
  }

  Write-Host ""
  Write-Host "--- 配置 $channelName ---" -ForegroundColor Yellow
  Write-Host "  将启动 openclaw channels add，按提示填写 Token / App ID / App Secret 等" -ForegroundColor DarkGray
  Write-Host "  获取方式:" -ForegroundColor DarkGray
  if ($ch -eq "1") { Write-Host "    Telegram: 与 @BotFather 对话，/newbot 创建机器人" -ForegroundColor DarkGray }
  if ($ch -eq "2") { Write-Host "    Discord: https://discord.com/developers/applications 创建应用并添加 Bot" -ForegroundColor DarkGray }
  if ($ch -eq "3") { Write-Host "    飞书: https://open.feishu.cn/app 创建企业自建应用" -ForegroundColor DarkGray }
  if ($ch -eq "4") { Write-Host "    钉钉: https://open.dingtalk.com 创建应用" -ForegroundColor DarkGray }
  if ($ch -eq "5") { Write-Host "    QQ: https://bot.q.qq.com 创建机器人" -ForegroundColor DarkGray }
  Write-Host ""
  # 若 openclaw channels add 支持 --channel，则直接进入该渠道配置
  $addArgs = @("channels", "add")
  try {
    $helpOut = & $OPENCLAW_CMD channels add --help 2>&1 | Out-String
    if ($helpOut -match '--channel\s') { $addArgs += "--channel", $channelId }
  } catch {}
  & $OPENCLAW_CMD @addArgs
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "`[OK`] 配置完成" -ForegroundColor Green
    if (Test-GatewayRunning -UseCache) {
      Write-Host ""
      $restart = Read-Host "Gateway 正在运行，是否立即重启以应用新配置？(Y/n)"
      $restart = if ($restart) { $restart.Trim().ToLower() } else { "y" }
      if ($restart -ne "n" -and $restart -ne "no") {
        $script:GatewayCacheTime = $null
        Run-OpenClaw "gateway restart" | Out-Null
        Write-Host "`[OK`] Gateway 已重启" -ForegroundColor Green
      }
    } else {
      Write-Host "  若 Gateway 已运行，请执行: openclaw gateway restart" -ForegroundColor DarkGray
    }
    Write-Host "  查看配对码: openclaw pairing list $channelId" -ForegroundColor DarkGray
    Write-Host "  批准配对: openclaw pairing approve $channelId <CODE>" -ForegroundColor DarkGray
  } else {
    Write-Host ("`[提示`] 退出码 " + $LASTEXITCODE) -ForegroundColor Yellow
  }
  Pause-Wait
}

# 清理路径输入：去除首尾空格、引号 " '
function Sanitize-PathInput {
  param([string]$InputPath)
  if (-not $InputPath) { return "" }
  $s = $InputPath.Trim().Replace('"', '').Replace("'", '').TrimEnd([char]92)
  return $s
}

# 从 PATH 移除指定路径并添加新路径
function Update-UserPathForMigration {
  param([string]$RemoveDir, [string]$AddDir)
  $RemoveDir = $RemoveDir.Trim().TrimEnd([char]92)
  $AddDir = $AddDir.Trim().TrimEnd([char]92)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $paths = $userPath -split ';' | Where-Object { $_.Trim() -and $_.Trim().TrimEnd([char]92) -ne $RemoveDir }
  $newPath = ($paths -join ';').Trim(';')
  if ($AddDir -and -not ($newPath -split ';' | Where-Object { $_.Trim().TrimEnd([char]92) -eq $AddDir })) {
    $newPath = if ($newPath) { "$AddDir;$newPath" } else { $AddDir }
  }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
}

# 检测 Gateway 是否在运行（UseCache 时 5 秒内复用结果，避免每次返回菜单都请求导致卡顿）
function Test-GatewayRunning {
  param([switch]$UseCache)
  if ($UseCache -and $null -ne $script:GatewayCacheTime) {
    $elapsed = [Environment]::TickCount - $script:GatewayCacheTime
    if ($elapsed -ge 0 -and $elapsed -lt 5000) {
      return $script:GatewayCache
    }
  }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18789/" -TimeoutSec 1 -ErrorAction Stop
    $result = $true
  } catch { $result = $false }
  if ($UseCache) {
    $script:GatewayCache = $result
    $script:GatewayCacheTime = [Environment]::TickCount
  }
  return $result
}

# 检查 openclaw 路径是否在用户 PATH 中
function Test-OpenClawPathInUserEnv {
  $openclawDir = (Split-Path $OPENCLAW_CMD -Parent).TrimEnd([char]92)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $paths = $userPath -split ';' | ForEach-Object { $_.Trim().TrimEnd([char]92) } | Where-Object { $_ }
  return ($paths | Where-Object { $_ -eq $openclawDir } | Measure-Object).Count -gt 0
}

# 一键添加 openclaw 路径到用户 PATH
function Add-OpenClawToPath {
  $openclawDir = Split-Path $OPENCLAW_CMD -Parent
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $paths = $userPath -split ';' | Where-Object { $_.Trim() }
  if ($paths -notcontains $openclawDir) {
    $newPath = if ($userPath) { "$openclawDir;$userPath" } else { $openclawDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = $openclawDir + ";" + $env:Path
    return $true
  }
  return $false
}

# 配置备份
function Backup-OpenClawConfig {
  param([string]$OutDir = $env:USERPROFILE)
  $zipName = "openclaw_backup_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".zip"
  $zipPath = Join-Path $OutDir $zipName
  if (-not (Test-Path $OPENCLAW_CONFIG)) {
    return $null
  }
  try {
    Compress-Archive -Path "$OPENCLAW_CONFIG\*" -DestinationPath $zipPath -Force
    return $zipPath
  } catch { return $null }
}

# 配置恢复
function Restore-OpenClawConfig {
  param([string]$ZipPath)
  if (-not (Test-Path $ZipPath)) { return $false }
  try {
    if (-not (Test-Path $OPENCLAW_CONFIG)) { New-Item -ItemType Directory -Path $OPENCLAW_CONFIG -Force | Out-Null }
    Expand-Archive -Path $ZipPath -DestinationPath $OPENCLAW_CONFIG -Force
    return $true
  } catch { return $false }
}

# 诊断导出
function Export-Diagnostic {
  param([string]$OutDir = $env:USERPROFILE)
  $fname = "openclaw_diagnostic_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".txt"
  $fpath = Join-Path $OutDir $fname
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine("=== OpenClaw Diagnostic Export ===")
  [void]$sb.AppendLine("Time: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
  [void]$sb.AppendLine("Path: $OPENCLAW_CMD")
  [void]$sb.AppendLine("Version: " + (& $OPENCLAW_CMD --version 2>$null))
  [void]$sb.AppendLine("Gateway: " + (if (Test-GatewayRunning) { "Running" } else { "Stopped" }))
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("--- openclaw doctor ---")
  [void]$sb.AppendLine((& $OPENCLAW_CMD doctor 2>&1 | Out-String))
  [void]$sb.AppendLine("--- openclaw status ---")
  [void]$sb.AppendLine((& $OPENCLAW_CMD status 2>&1 | Out-String))
  try {
    [System.IO.File]::WriteAllText($fpath, $sb.ToString(), [System.Text.Encoding]::UTF8)
    return $fpath
  } catch { return $null }
}

# 插件 manifest 补齐：extensions 下 clawdbot.plugin.json -> openclaw.plugin.json（避免 plugin manifest not found）
function Ensure-ExtensionManifestCompat {
  $configDir = Get-OpenClawConfigDir
  $extRoot = Join-Path $configDir "extensions"
  if (-not (Test-Path $extRoot)) { return @() }
  $fixed = @()
  foreach ($dir in (Get-ChildItem -Path $extRoot -Directory -ErrorAction SilentlyContinue)) {
    $oldManifest = Join-Path $dir.FullName "clawdbot.plugin.json"
    $newManifest = Join-Path $dir.FullName "openclaw.plugin.json"
    if ((Test-Path $oldManifest) -and -not (Test-Path $newManifest)) {
      try {
        Copy-Item -Path $oldManifest -Destination $newManifest -Force
        $fixed += $dir.Name
      } catch {}
    }
  }
  return $fixed
}

# 一键最小修复：manifest补齐 -> doctor --fix -> plugins校验 -> skills check -> gateway自检
function Invoke-MinimalRepair {
  $configDir = Get-OpenClawConfigDir
  $env:OPENCLAW_STATE_DIR = $configDir
  $logs = @()
  $logs += "配置目录: $configDir"

  Write-Host ""
  Write-Host "`[1/5`] manifest 补齐..." -ForegroundColor Cyan
  $fixed = Ensure-ExtensionManifestCompat
  if ($fixed.Count -gt 0) {
    $logs += "manifest补齐: 已修复 $($fixed.Count) 项 [$($fixed -join ', ')]"
    Write-Host "`[OK`] 已补齐 $($fixed.Count) 个插件 manifest" -ForegroundColor Green
  } else {
    $logs += "manifest补齐: 无变更"
    Write-Host "`[OK`] 无需补齐" -ForegroundColor DarkGray
  }

  Write-Host "`[2/5`] doctor --fix..." -ForegroundColor Cyan
  Run-OpenClaw "doctor --fix" 2>$null | Out-Null
  $logs += "doctor --fix: 已执行"

  Write-Host "`[3/5`] plugins 校验..." -ForegroundColor Cyan
  $pOut = Run-OpenClaw "plugins list" 2>&1 | Out-String
  $logs += "plugins: $(if ($LASTEXITCODE -eq 0) { 'ok' } else { 'error' })"

  Write-Host "`[4/5`] skills check..." -ForegroundColor Cyan
  Run-OpenClaw "skills check" 2>$null | Out-Null
  $logs += "skills check: 已执行"

  Write-Host "`[5/5`] gateway 自检..." -ForegroundColor Cyan
  $gwOk = Test-GatewayRunning
  $logs += "gateway: $(if ($gwOk) { '运行中' } else { '已停止' })"
  Write-Host ("`[OK`] Gateway: $(if ($gwOk) { '运行中' } else { '已停止' })") -ForegroundColor $(if ($gwOk) { "Green" } else { "DarkGray" })

  Write-Host ""
  Write-Host "`[完成`] 最小修复已执行" -ForegroundColor Green
  return ($logs -join "`n")
}

# 生成可复制工单摘要（失败时供用户发给维护者）
function Write-TicketSummary {
  param([string]$Action, [string]$ErrorMsg)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $firstLine = ($ErrorMsg -split "`n")[0]
  if (-not $firstLine) { $firstLine = $ErrorMsg }
  $summary = @"
时间: $ts
操作: $Action
错误摘要: $firstLine
建议: 点击「一键最小修复」后重试；若仍失败请附上完整日志与截图。
"@
  Write-Host ""
  Write-Host "--- 可复制工单摘要（发给维护者）---" -ForegroundColor Yellow
  Write-Host $summary -ForegroundColor White
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  return $summary
}

# 获取 npm 上最新版本号
function Get-LatestOpenClawVersion {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "https://registry.npmjs.org/openclaw/latest" -TimeoutSec 10
    $j = $r.Content | ConvertFrom-Json
    return $j.version
  } catch { return $null }
}

# 等待 Gateway 就绪（最多等待秒数，返回是否成功）
function Wait-GatewayReady {
  param([int]$MaxWaitSec = 18)
  $url = "http://127.0.0.1:18789/"
  $elapsed = 0
  while ($elapsed -lt $MaxWaitSec) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2 -ErrorAction Stop
      return $true
    } catch {}
    Start-Sleep -Milliseconds 500
    $elapsed += 0.5
  }
  return $false
}

function Pause-Wait {
  Write-Host ""
  Read-Host "按回车键继续"
}

# 根据 provider 获取默认 base URL
function Get-ProviderBaseUrl {
  param([string]$provider)
  switch ($provider) {
    "anthropic" { return "https://api.anthropic.com" }
    "openai" { return "https://api.openai.com/v1" }
    "moonshot" { return "https://api.moonshot.cn/v1" }
    "deepseek" { return "https://api.deepseek.com/v1" }
    "siliconflow" { return "https://api.siliconflow.cn/v1" }
    "zai" { return "https://open.bigmodel.cn/api/paas/v4" }
    default { return "" }
  }
}

# === 固定硅基流动模型列表（引流用）===
# 恢复提示：搜索 "FIXED_SILICONFLOW_MODELS" 和 "provider -eq `"siliconflow`""，
# 删除 $FIXED_SILICONFLOW_MODELS 数组，将 siliconflow 分支改回与其它 provider 一样调用 Get-AvailableModels
$FIXED_SILICONFLOW_MODELS = @(
  @{ id = "deepseek-ai/DeepSeek-V3"; label = "DeepSeek V3（推荐）" },
  @{ id = "Qwen/Qwen2.5-72B-Instruct"; label = "Qwen2.5 72B" },
  @{ id = "GLM-4-9B-Chat"; label = "GLM-4-9B / GLM-5" },
  @{ id = "moonshotai/Kimi-K2-Instruct-0905"; label = "Kimi K2（可对话）" },
  @{ id = "deepseek-ai/DeepSeek-R1"; label = "DeepSeek R1（备选）" }
)

# 拉取模型列表 (与软件 discover_available_models 逻辑一致)
function Get-AvailableModels {
  param([string]$provider, [string]$baseUrl, [string]$apiKey)
  $url = $baseUrl.TrimEnd('/') + "/models"
  if ($provider -eq "anthropic") {
    $url = $baseUrl.TrimEnd('/') + "/v1/models"
  }
  $headers = @{}
  if ($provider -eq "anthropic") {
    $headers["x-api-key"] = $apiKey
    $headers["anthropic-version"] = "2023-06-01"
    $headers["Content-Type"] = "application/json"
  } else {
    $headers["Authorization"] = "Bearer " + $apiKey
    $headers["Content-Type"] = "application/json"
  }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method GET -Uri $url -Headers $headers -TimeoutSec 20
    $json = $r.Content | ConvertFrom-Json
    $data = $json.data
    if (-not $data) { return @() }
    $all = @()
    foreach ($item in $data) {
      $id = $item.id
      if ($id) {
        $s = $id.ToLower()
        if ($s -notmatch "embedding|whisper|tts|moderation|image|rerank") {
          $all += $id
        }
      }
    }
    if ($all.Count -eq 0) {
      foreach ($item in $data) {
        if ($item.id) { $all += $item.id }
      }
    }
    return ($all | Select-Object -Unique)
  } catch {
    Write-Host ("`[失败`] 拉取模型列表: " + $_.Exception.Message) -ForegroundColor Red
    return @()
  }
}

Write-Host "正在检测环境..." -ForegroundColor Yellow
if (-not (Ensure-OpenClaw)) {
  Read-Host "按回车键退出"
  exit 1
}

# 命令行快捷模式
  $act = if ($Action) { $Action.Trim().ToLower() } else { "" }
if ($act) {
  switch ($act) {
    "minimal-repair" { Invoke-MinimalRepair | Out-Null; exit 0 }
    "gateway-start" { if (Start-Gateway-AndWait) { Write-Host "Gateway started" -ForegroundColor Green } else { Write-Host "Gateway start failed" -ForegroundColor Red }; exit 0 }
    "gateway-stop" { Run-OpenClaw "gateway stop" | Out-Null; exit 0 }
    "open-chat" {
      if (Start-Gateway-AndWait) {
        $token = Get-GatewayToken
        $url = if ($token) { "http://127.0.0.1:18789/?token=$token" } else { "http://127.0.0.1:18789/" }
        Start-Process $url
      }
      exit 0
    }
    "status" { Run-OpenClaw "status"; exit 0 }
    "doctor" { Run-OpenClaw "doctor"; exit 0 }
    default { Write-Host "Unknown -Action: $Action. Use: minimal-repair, gateway-start, gateway-stop, open-chat, status, doctor" -ForegroundColor Yellow; exit 1 }
  }
}

while ($true) {
  Write-Header
  $raw = Read-Host "请选择"
  $choice = if ($raw) { $raw.Trim() } else { "" }

  switch ($choice) {
    "1" {
      Write-Host ""
      Write-Host "--- 快速配置 ---" -ForegroundColor Yellow
      Write-Host "  [a] 交互式配置 - 完整向导 (openclaw onboard)" -ForegroundColor White
      Write-Host "  [b] 快速配置 - 选择提供商 + API Key + 可选安装 Skills" -ForegroundColor White
      Write-Host "  [c] 接入对话渠道 - Telegram / QQ / 飞书 / 钉钉 / Discord" -ForegroundColor White
      Write-Host "  [d] 查看所有渠道状态 - 一键列出各渠道是否已配置" -ForegroundColor White
      Write-Host "  [0]  返回主菜单" -ForegroundColor White
      Write-Host ""
      $cfg = Read-Host "请选择" 
      $cfg = if ($cfg) { $cfg.Trim().ToLower() } else { "" }
      if ($cfg -eq "a") {
        Write-Host ""
        Write-Host "正在打开交互式配置向导 (openclaw onboard)..." -ForegroundColor Cyan
        Write-Host "将在新窗口中运行，完成后关闭该窗口即可返回" -ForegroundColor DarkGray
        $ocDir = Split-Path $OPENCLAW_CMD -Parent
        try {
          Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$ocDir`" && `"$OPENCLAW_CMD`" onboard && pause" -Wait
        } catch {
          Write-Host "`[备用`] 在当前窗口运行..." -ForegroundColor Yellow
          $ec = Run-OpenClaw "onboard"
          if ($ec -ne 0 -and $ec -ne $null) { Write-Host ("`[提示`] 命令退出码 " + $ec) -ForegroundColor Yellow }
        }
      } elseif ($cfg -eq "b") {
        $acOk = Test-ApiProviderConfigured "anthropic"
        $oaOk = Test-ApiProviderConfigured "openai"
        Write-Host ""
        Write-Host "--- 选择 AI 提供商 ---" -ForegroundColor Yellow
        Write-Host ("  [1] Anthropic (Claude)" + $(if ($acOk) { " - 已配置" } else { "" })) -ForegroundColor $(if ($acOk) { "Green" } else { "White" })
        Write-Host ("  [2] OpenAI (GPT)" + $(if ($oaOk) { " - 已配置" } else { "" })) -ForegroundColor $(if ($oaOk) { "Green" } else { "White" })
        Write-Host ("  [3] Moonshot (月之暗面)" + $(if ($oaOk) { " - 已配置" } else { "" })) -ForegroundColor $(if ($oaOk) { "Green" } else { "White" })
        Write-Host ("  [4] DeepSeek" + $(if ($oaOk) { " - 已配置" } else { "" })) -ForegroundColor $(if ($oaOk) { "Green" } else { "White" })
        Write-Host ("  [5] 硅基流动 (SiliconFlow)" + $(if ($oaOk) { " - 已配置" } else { "" })) -ForegroundColor $(if ($oaOk) { "Green" } else { "White" })
        Write-Host ("  [6] Z.AI (智谱)" + $(if ($oaOk) { " - 已配置" } else { "" })) -ForegroundColor $(if ($oaOk) { "Green" } else { "White" })
        Write-Host "  [7] 自定义 Base URL" -ForegroundColor White
        Write-Host "  [0] 取消" -ForegroundColor White
        Write-Host ""
        $providerChoice = Read-Host "请选择"
        $providerChoice = if ($providerChoice) { $providerChoice.Trim() } else { "" }
        if ($providerChoice -eq "0") { continue }
        $provider = ""
        $baseUrl = ""
        $compat = "openai"
        switch ($providerChoice) {
          "1" { $provider = "anthropic"; $baseUrl = Get-ProviderBaseUrl "anthropic"; $compat = "anthropic" }
          "2" { $provider = "openai"; $baseUrl = Get-ProviderBaseUrl "openai" }
          "3" { $provider = "moonshot"; $baseUrl = Get-ProviderBaseUrl "moonshot" }
          "4" { $provider = "deepseek"; $baseUrl = Get-ProviderBaseUrl "deepseek" }
          "5" { $provider = "siliconflow"; $baseUrl = Get-ProviderBaseUrl "siliconflow" }
          "6" { $provider = "zai"; $baseUrl = Get-ProviderBaseUrl "zai" }
          "7" {
            $provider = "custom"
            $baseUrl = Read-Host "自定义 Base URL (如 https://api.openai.com/v1)"
            if (-not $baseUrl) {
              Write-Host "`[取消`] Base URL 不能为空" -ForegroundColor Yellow
              Pause-Wait
              continue
            }
          }
          default { Write-Host "无效输入" -ForegroundColor Yellow; continue }
        }
        if (-not $provider) { continue }
        $apiKey = Read-Host "API Key (输入后按回车)"
        if (-not $apiKey) {
          Write-Host "`[取消`] 未输入 API Key" -ForegroundColor Yellow
          Pause-Wait
          continue
        }
        $modelId = ""
        if ($provider -eq "siliconflow") {
          Write-Host ""
          Write-Host "--- 选择模型 (硅基流动) ---" -ForegroundColor Yellow
          $i = 1
          foreach ($m in $FIXED_SILICONFLOW_MODELS) {
            Write-Host ('  [' + $i + '] ' + $m.label + ' (' + $m.id + ')') -ForegroundColor White
            $i++
          }
          Write-Host ""
          $sel = Read-Host "请选择 (1-$($FIXED_SILICONFLOW_MODELS.Count)，默认1)"
          $sel = if ($sel) { $sel.Trim() } else { "1" }
          $idx = 0
          if ([int]::TryParse($sel, [ref]$idx) -and $idx -ge 1 -and $idx -le $FIXED_SILICONFLOW_MODELS.Count) {
            $modelId = $FIXED_SILICONFLOW_MODELS[$idx - 1].id
          } else {
            $modelId = $FIXED_SILICONFLOW_MODELS[0].id
          }
          Write-Host "想用更多高端模型？加群 1085253453 解锁！" -ForegroundColor Cyan
        } elseif ($provider -ne "custom") {
          Write-Host ""
          Write-Host "正在拉取可用模型列表..." -ForegroundColor Cyan
          $models = Get-AvailableModels -provider $provider -baseUrl $baseUrl -apiKey $apiKey
          if ($models -and $models.Count -gt 0) {
            Write-Host ""
            Write-Host "--- 选择模型 (输入序号) ---" -ForegroundColor Yellow
            $i = 1
            foreach ($m in $models) {
              Write-Host ('  [' + $i + '] ' + $m) -ForegroundColor White
              $i++
              if ($i -gt 30) { Write-Host "  ... (仅显示前30个)" -ForegroundColor DarkGray; break }
            }
            Write-Host "  [0] 手动输入模型 ID (自定义)" -ForegroundColor White
            Write-Host ""
            $sel = Read-Host "请选择"
            $sel = if ($sel) { $sel.Trim() } else { "" }
            if ($sel -eq "0") {
              $modelId = Read-Host "模型 ID"
            } elseif ($sel -match '^\d+$' -and [int]$sel -ge 1 -and [int]$sel -le $models.Count) {
              $modelId = $models[[int]$sel - 1]
            }
          }
        }
        if (-not $modelId -and $provider -eq "custom") {
          $modelId = Read-Host "模型 ID (如 gpt-4)"
          if (-not $modelId) {
            Write-Host "`[取消`] 模型 ID 不能为空" -ForegroundColor Yellow
            Pause-Wait
            continue
          }
        }
        if (-not $modelId) {
          switch ($provider) {
            "anthropic" { $modelId = "claude-3-5-haiku-latest" }
            "openai" { $modelId = "gpt-4o-mini" }
            "moonshot" { $modelId = "moonshot-v1-32k" }
            "deepseek" { $modelId = "deepseek-chat" }
            "siliconflow" { $modelId = "deepseek-ai/DeepSeek-V3" }
            "zai" { $modelId = "glm-4-flash" }
            default { $modelId = "gpt-4o-mini" }
          }
          Write-Host ("使用默认模型: " + $modelId) -ForegroundColor DarkGray
        }
        $installSkillsChoice = Read-Host "是否安装官方 Skills 依赖？(Y/n)"
        $installSkillsChoice = if ($installSkillsChoice) { $installSkillsChoice.Trim().ToLower() } else { "y" }
        $skipSkills = ($installSkillsChoice -eq "n" -or $installSkillsChoice -eq "no")

        $onboardArgs = @(
          "onboard", "--non-interactive",
          "--mode", "local",
          "--auth-choice", "custom-api-key",
          "--custom-base-url", $baseUrl.TrimEnd('/'),
          "--custom-model-id", $modelId,
          "--custom-api-key", $apiKey,
          "--custom-compatibility", $compat,
          "--node-manager", "npm",
          "--secret-input-mode", "plaintext",
          "--gateway-port", "18789",
          "--gateway-bind", "loopback",
          "--skip-channels", "--skip-daemon",
          "--accept-risk"
        )
        if ($skipSkills) { $onboardArgs += "--skip-skills" }
        Write-Host ""
        $manifestFixed = Ensure-ExtensionManifestCompat
        if ($manifestFixed.Count -gt 0) { Write-Host "`[预处理`] 已补齐 $($manifestFixed.Count) 个插件 manifest" -ForegroundColor DarkGray }
        Write-Host "正在执行快速配置 (模型: $modelId，Skills: $(if ($skipSkills) { '跳过' } else { '安装' }))..." -ForegroundColor Cyan
        $env:OPENCLAW_STATE_DIR = Get-OpenClawConfigDir
        & $OPENCLAW_CMD @onboardArgs
        if ($LASTEXITCODE -eq 0) {
          Write-Host "`[OK`] 完成" -ForegroundColor Green
        } else {
          Write-Host ("`[提示`] 退出码 " + $LASTEXITCODE) -ForegroundColor Yellow
        }
      } elseif ($cfg -eq "c") {
        Invoke-ChannelSetup
      } elseif ($cfg -eq "d") {
        Show-AllChannelStatus
      } elseif ($cfg -eq "0") { continue }
      else { Write-Host "无效输入" -ForegroundColor Yellow }
      Pause-Wait
    }
    "2" {
      Write-Host ""
      Write-Host "正在启动 Gateway..." -ForegroundColor Cyan
      if (Start-Gateway-AndWait) {
        Write-Host "`[OK`] Gateway 已启动" -ForegroundColor Green
        Write-Host "Control UI: http://127.0.0.1:18789/" -ForegroundColor DarkGray
      } else {
        Write-Host "`[失败`] Gateway 启动失败，请用选项 10->e 修复；若 schtasks 报错，用 10->f 前台启动" -ForegroundColor Red
      }
      Pause-Wait
    }
    "3" {
      :submenu while ($true) {
        Write-Submenu
        $rawSub = Read-Host "请选择命令"
        $sub = if ($rawSub) { $rawSub.Trim() } else { "" }
        switch ($sub) {
          "1" { Run-OpenClaw "gateway status"; Pause-Wait }
          "2" { Start-Gateway-AndWait | Out-Null; Run-OpenClaw "gateway status"; Pause-Wait }
          "3" { $script:GatewayCacheTime = $null; Run-OpenClaw "gateway stop"; Pause-Wait }
          "4" { $script:GatewayCacheTime = $null; Run-OpenClaw "gateway restart"; Pause-Wait }
          "5" { Run-OpenClaw "models list"; Pause-Wait }
          "6" { Run-OpenClaw "channels status"; Pause-Wait }
          "7" { Run-OpenClaw "doctor"; Pause-Wait }
          "8" { Run-OpenClaw "status"; Pause-Wait }
          "0" { break submenu }
          default { Write-Host "无效输入" -ForegroundColor Yellow }
        }
      }
    }
    "4" {
      Write-Host ""
      Run-OpenClaw | Out-Null
      Pause-Wait
    }
    "5" {
      Write-Host ""
      $curVer = (& $OPENCLAW_CMD --version 2>$null)
      Write-Host "正在检查更新..." -ForegroundColor Cyan
      $latestVer = Get-LatestOpenClawVersion
      if ($latestVer) {
        if ($curVer -and $curVer.Trim() -eq $latestVer) {
          Write-Host ("`[OK`] 已是最新版本: " + $curVer) -ForegroundColor Green
          Pause-Wait
          continue
        }
        Write-Host ('当前: ' + $curVer + ' 最新: ' + $latestVer) -ForegroundColor DarkGray
      }
      Write-Host "正在更新 OpenClaw..." -ForegroundColor Cyan
      $prefixDir = Split-Path $OPENCLAW_CMD -Parent
      if (Test-Path $OPENCLAW_CMD) {
        npm install -g openclaw@latest --prefix $prefixDir
      } else {
        npm install -g openclaw@latest
      }
      if ($LASTEXITCODE -eq 0) {
        Write-Host "OK Done" -ForegroundColor Green
        $ver = (& $OPENCLAW_CMD --version 2>$null)
        if ($ver) { Write-Host ("`[版本`] " + $ver) -ForegroundColor DarkGray }
      } else {
        Write-Host "`[失败`] 更新失败" -ForegroundColor Red
      }
      Pause-Wait
    }
    "6" {
      Write-Host ""
      Write-Host "正在启动 Gateway 并打开对话界面..." -ForegroundColor Cyan
      if (Start-Gateway-AndWait) {
        $ready = $true
        $token = Get-GatewayToken
        $url = "http://127.0.0.1:18789/"
        if ($token) { $url = "http://127.0.0.1:18789/?token=$token" }
        Write-Host "对话界面: $url" -ForegroundColor Green
        if (-not $token) { Write-Host "`[提示`] 未找到 token，请从 Control UI 获取" -ForegroundColor Yellow }
        try {
          Start-Process $url -ErrorAction Stop
        } catch {
          try { [System.Diagnostics.Process]::Start($url) } catch {}
          Write-Host "`[提示`] 请手动打开浏览器访问: $url" -ForegroundColor Yellow
        }
      } else {
        Write-Host "`[失败`] Gateway 启动失败，请用选项 10->e 修复；若 schtasks 报错，用 10->f 前台启动" -ForegroundColor Red
      }
      Pause-Wait
    }
    "7" {
      :cfgmenu while ($true) {
        Write-Host ""
        Write-Host "--- 配置路径 ---" -ForegroundColor Yellow
        $ocDir = Split-Path $OPENCLAW_CMD -Parent
        Write-Host "  当前配置路径: $OPENCLAW_CONFIG" -ForegroundColor Cyan
        Write-Host "  (存放 openclaw.json、channels.json 等，Gateway 与脚本需一致)" -ForegroundColor DarkGray
        Write-Host "  OpenClaw 安装路径: $ocDir" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  [a] 设置自定义配置路径 - 安装在其他盘时填写" -ForegroundColor White
        Write-Host "  [b] 恢复默认路径 - 清空自定义，使用 ~/.openclaw" -ForegroundColor White
        Write-Host "  [c] 一键添加 OpenClaw 到 PATH" -ForegroundColor White
        Write-Host "  [d] 安装在其他盘时如何填写？- 查看指引" -ForegroundColor White
        Write-Host "  [0] 返回主菜单" -ForegroundColor White
        Write-Host ""
        $cfgChoice = Read-Host "请选择"
        $cfgChoice = if ($cfgChoice) { $cfgChoice.Trim().ToLower() } else { "" }
        if ($cfgChoice -eq "0") { break cfgmenu }
        if ($cfgChoice -eq "a") {
          Write-Host ""
          Write-Host "填写配置目录完整路径（内含 openclaw.json 的文件夹）" -ForegroundColor Cyan
          Write-Host "示例: D:\openclaw\.openclaw  或  E:\my-config" -ForegroundColor DarkGray
          $customPath = Read-Host "路径 (留空取消)"
          $customPath = Sanitize-PathInput $customPath
          if (-not $customPath) { Write-Host "已取消" -ForegroundColor DarkGray; Pause-Wait; continue }
          $cfgFile = Join-Path $customPath "openclaw.json"
          if (-not (Test-Path $cfgFile)) {
            Write-Host "`[提示`] 该目录下未找到 openclaw.json，请确认路径正确" -ForegroundColor Yellow
            $force = Read-Host "仍要设置? (y/N)"
            if ($force -ne 'y' -and $force -ne 'Y') { Pause-Wait; continue }
          }
          [Environment]::SetEnvironmentVariable("OPENCLAW_STATE_DIR", $customPath, "User")
          $env:OPENCLAW_STATE_DIR = $customPath
          $script:OPENCLAW_CONFIG = $customPath
          Write-Host "`[OK`] 已设置，新开终端后生效；当前会话已切换" -ForegroundColor Green
          Write-Host "请执行 gateway install --force 或选项 10->e 修复 Gateway 任务" -ForegroundColor DarkGray
          Pause-Wait
        } elseif ($cfgChoice -eq "b") {
          [Environment]::SetEnvironmentVariable("OPENCLAW_STATE_DIR", $null, "User")
          Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue
          $script:OPENCLAW_CONFIG = "$env:USERPROFILE\.openclaw"
          Write-Host "`[OK`] 已恢复默认路径" -ForegroundColor Green
          Pause-Wait
        } elseif ($cfgChoice -eq "c") {
          if (-not (Test-OpenClawPathInUserEnv)) {
            if (Add-OpenClawToPath) {
              Write-Host "`[OK`] 已添加到 PATH，新开终端后生效" -ForegroundColor Green
            } else {
              Write-Host "`[提示`] 添加失败或已在 PATH 中" -ForegroundColor Yellow
            }
          } else {
            Write-Host "`[OK`] OpenClaw 路径已在 PATH 中" -ForegroundColor Green
          }
          Pause-Wait
        } elseif ($cfgChoice -eq "d") {
          Write-Host ""
          Write-Host "--- 安装在其他盘时如何填写配置路径 ---" -ForegroundColor Yellow
          Write-Host "  1. 填写的是「配置目录」，不是 OpenClaw 程序安装目录" -ForegroundColor White
          Write-Host "  2. 在资源管理器中找到含 openclaw.json 的文件夹，复制地址栏路径" -ForegroundColor White
          Write-Host "  3. 常见位置: D:\openclaw\.openclaw  E:\openclaw-config" -ForegroundColor White
          Write-Host "  4. 可用 \ 或 /，末尾不要加反斜杠" -ForegroundColor White
          Write-Host ""
          Pause-Wait
        } else { Write-Host "无效输入" -ForegroundColor Yellow }
      }
    }
    "8" {
      Write-Host ""
      Write-Host "OpenClaw 文档:" -ForegroundColor Cyan
      Write-Host "  https://docs.openclaw.ai/cli" -ForegroundColor White
      Write-Host "  https://docs.openclaw.ai/" -ForegroundColor White
      try { Start-Process "https://docs.openclaw.ai/cli" } catch {}
      Pause-Wait
    }
    "9" {
      :locmenu while ($true) {
        Write-Host ""
        Write-Host "--- 安装位置管理 ---" -ForegroundColor Yellow
        Write-Host "  [a] 一键嗅探 - 检测系统中所有 OpenClaw 安装" -ForegroundColor White
        Write-Host "  [b] 删除安装 - 卸载指定位置的 OpenClaw" -ForegroundColor White
        Write-Host "  [c] 热迁移 - 迁移到新目录 (删除源后会自动重新注册 Gateway)" -ForegroundColor White
        Write-Host "  [0]  返回主菜单" -ForegroundColor White
        Write-Host ""
        $locChoice = Read-Host "请选择"
        $locChoice = if ($locChoice) { $locChoice.Trim().ToLower() } else { "" }
        if ($locChoice -eq "0") { break locmenu }
        if ($locChoice -eq "a") {
          Write-Host ""
          Write-Host "正在嗅探 OpenClaw 安装位置..." -ForegroundColor Cyan
          $locs = @(Get-OpenClawLocations)
          if ($locs.Count -eq 0) {
            Write-Host "`[未找到`] 未检测到任何 OpenClaw 安装" -ForegroundColor Yellow
          } else {
            Write-Host ""
            $i = 1
            foreach ($loc in $locs) {
              $cur = if ($loc.Current) { " (当前)" } else { "" }
              $ver = if ($loc.Version) { " $($loc.Version)" } else { "" }
              Write-Host ('  [' + $i + '] ' + $loc.Path + $ver + $cur) -ForegroundColor White
              $i++
            }
          }
          Pause-Wait
        } elseif ($locChoice -eq "b") {
          Write-Host ""
          $locs = @(Get-OpenClawLocations)
          if ($locs.Count -eq 0) {
            Write-Host "`[未找到`] 无可删除的安装" -ForegroundColor Yellow
            Pause-Wait
            continue
          }
          Write-Host "选择要删除的安装:" -ForegroundColor Yellow
          $i = 1
          foreach ($loc in $locs) {
            $cur = if ($loc.Current) { " (当前)" } else { "" }
            Write-Host ('  [' + $i + '] ' + $loc.Path + $cur) -ForegroundColor White
            $i++
          }
          Write-Host "  [0] 取消" -ForegroundColor White
          Write-Host ""
          $sel = Read-Host "请选择"
          $sel = if ($sel) { $sel.Trim() } else { "" }
          if ($sel -eq "0") { continue }
          $idx = 0
          if ([int]::TryParse($sel, [ref]$idx) -and $idx -ge 1 -and $idx -le $locs.Count) {
            $target = $locs[$idx - 1]
            $confirm = Read-Host "确认删除 $($target.Path) ? (y/N)"
            if ($confirm -eq 'y' -or $confirm -eq 'Y') {
              Write-Host "正在卸载..." -ForegroundColor Cyan
              npm uninstall -g openclaw --prefix $target.Path 2>$null
              if ($LASTEXITCODE -eq 0) {
                Write-Host "`[OK`] 已卸载" -ForegroundColor Green
                Update-UserPathForMigration -RemoveDir $target.Path -AddDir $null
              } else {
                Write-Host "`[提示`] npm 卸载可能未完全清理，可手动删除目录" -ForegroundColor Yellow
                Update-UserPathForMigration -RemoveDir $target.Path -AddDir $null
              }
            } else { Write-Host "已取消" -ForegroundColor DarkGray }
          } else { Write-Host "无效输入" -ForegroundColor Yellow }
          Pause-Wait
        } elseif ($locChoice -eq "c") {
          Write-Host ""
          $locs = @(Get-OpenClawLocations)
          if ($locs.Count -eq 0) {
            Write-Host "`[未找到`] 无可迁移的安装，请先安装 OpenClaw" -ForegroundColor Yellow
            Pause-Wait
            continue
          }
            Write-Host "选择要迁移的源安装:" -ForegroundColor Yellow
          $i = 1
          foreach ($loc in $locs) {
            $cur = if ($loc.Current) { " (当前)" } else { "" }
            Write-Host ('  [' + $i + '] ' + $loc.Path + $cur) -ForegroundColor White
            $i++
          }
          Write-Host "  [0] 取消" -ForegroundColor White
          Write-Host ""
          $sel = Read-Host "请选择源 (0=取消)"
          $sel = if ($sel) { $sel.Trim() } else { "" }
          if ($sel -eq "0") { continue }
          $idx = 0
          if (-not ([int]::TryParse($sel, [ref]$idx)) -or $idx -lt 1 -or $idx -gt $locs.Count) {
            Write-Host "无效输入" -ForegroundColor Yellow
            Pause-Wait
            continue
          }
          $srcLoc = $locs[$idx - 1]
          Write-Host ""
          $newDir = Read-Host "输入目标目录 (如 D:\openclow)"
          $newDir = Sanitize-PathInput $newDir
          if (-not $newDir) {
            Write-Host "`[取消`] 未输入目标目录" -ForegroundColor Yellow
            Pause-Wait
            continue
          }
          $drive = Split-Path $newDir -Qualifier -ErrorAction SilentlyContinue
          if ($drive -and -not (Test-Path $drive)) {
            Write-Host ("`[失败`] 驱动器不存在: " + $drive) -ForegroundColor Red
            Write-Host "请使用已存在的盘符，如 C:\openclow" -ForegroundColor Yellow
            Pause-Wait
            continue
          }
          if (-not (Test-Path $newDir)) {
            try { New-Item -ItemType Directory -Path $newDir -Force | Out-Null } catch {
              Write-Host ("`[失败`] 无法创建目录: " + $newDir) -ForegroundColor Red
              if ($_.Exception.Message -match "drive|Drive") {
                Write-Host "该盘符可能不存在，请检查路径" -ForegroundColor Yellow
              }
              Pause-Wait
              continue
            }
          }
          Write-Host ""
          Write-Host "正在迁移 (安装到新位置)..." -ForegroundColor Cyan
          npm install -g openclaw@latest --prefix $newDir
          if ($LASTEXITCODE -ne 0) {
            Write-Host "`[失败`] 安装到新位置失败" -ForegroundColor Red
            Pause-Wait
            continue
          }
          $newCmd = if (Test-Path (Join-Path $newDir "openclaw.cmd")) {
            Join-Path $newDir "openclaw.cmd"
          } else {
            Join-Path $newDir "openclaw.ps1"
          }
          $mjsPath = Join-Path $newDir "node_modules\openclaw\openclaw.mjs"
          if (-not (Test-Path $mjsPath)) {
            Write-Host "`[失败`] 安装不完整，未找到 openclaw.mjs，请重试或使用直接安装" -ForegroundColor Red
            Pause-Wait
            continue
          }
          Write-Host "正在更新 PATH..." -ForegroundColor Cyan
          Update-UserPathForMigration -RemoveDir $srcLoc.Path -AddDir $newDir
          $script:OPENCLAW_CMD = $newCmd
          $env:PATH = "$newDir;$env:PATH"
          Write-Host ("`[OK`] 热迁移完成，新路径: " + $newDir) -ForegroundColor Green
          Write-Host "`[提示`] 新开终端后 PATH 生效；当前脚本已切换至新路径" -ForegroundColor DarkGray
          Write-Host ""
          $delSrc = Read-Host "是否删除源安装 $($srcLoc.Path) ? (y/N)"
          if ($delSrc -eq 'y' -or $delSrc -eq 'Y') {
            Write-Host "正在停止 Gateway..." -ForegroundColor Cyan
            $script:GatewayCacheTime = $null
            Run-OpenClaw "gateway stop" | Out-Null
            Start-Sleep -Seconds 2
            schtasks /delete /tn "OpenClaw Gateway" /f 2>$null | Out-Null
            Write-Host "正在卸载源安装..." -ForegroundColor Cyan
            npm uninstall -g openclaw --prefix $srcLoc.Path 2>$null
            Update-UserPathForMigration -RemoveDir $srcLoc.Path -AddDir $null
            Write-Host "`[OK`] 源安装已删除" -ForegroundColor Green
            Write-Host "正在用新路径重新注册 Gateway 任务..." -ForegroundColor Cyan
            Run-OpenClaw "gateway install --force" | Out-Null
            Start-Sleep -Seconds 1
            if (Start-Gateway-Hidden) {
              Write-Host "`[OK`] Gateway 已就绪" -ForegroundColor Green
            } else {
              Write-Host "`[提示`] 请用选项 2 启动 Gateway" -ForegroundColor Yellow
            }
          }
          Pause-Wait
        } else { Write-Host "无效输入" -ForegroundColor Yellow }
      }
    }
    "10" {
      :toolmenu while ($true) {
        Write-Host ""
        Write-Host "--- 工具箱 ---" -ForegroundColor Yellow
        Write-Host "  [a] 配置备份 - 导出 .openclaw 为 zip" -ForegroundColor White
        Write-Host "  [b] 配置恢复 - 从 zip 恢复配置" -ForegroundColor White
        Write-Host "  [c] 诊断导出 - 导出完整诊断信息" -ForegroundColor White
        Write-Host "  [d] 代理设置 - 设置 HTTP/HTTPS 代理" -ForegroundColor White
        Write-Host "  [e] 修复 Gateway 任务 - 热迁移/删除源后启动失败时用" -ForegroundColor White
        Write-Host "  [f] 前台启动 Gateway - 计划任务失败时的替代方案，新窗口运行" -ForegroundColor White
        Write-Host "  [g] Skills 管理 - 检查 / 一键安装或更新官方 Skills" -ForegroundColor White
        Write-Host "  [h] 一键最小修复 - manifest补齐/配置清理/plugins/skills/gateway 自检（适合小白）" -ForegroundColor White
        Write-Host "  [0]   返回主菜单" -ForegroundColor White
        Write-Host ""
        $toolChoice = Read-Host "请选择"
        $toolChoice = if ($toolChoice) { $toolChoice.Trim().ToLower() } else { "" }
        if ($toolChoice -eq "0") { break toolmenu }
        if ($toolChoice -eq "a") {
          Write-Host ""
          $out = Read-Host "备份保存目录 (默认: 用户目录)"
          $out = if ($out) { Sanitize-PathInput $out } else { "" }
          if (-not $out) { $out = $env:USERPROFILE }
          $zip = Backup-OpenClawConfig -OutDir $out
          if ($zip) {
            Write-Host ("`[OK`] 备份已保存: " + $zip) -ForegroundColor Green
          } else {
            Write-Host "`[失败`] 备份失败或配置目录为空" -ForegroundColor Red
          }
          Pause-Wait
        } elseif ($toolChoice -eq "b") {
          Write-Host ""
          $zipPath = Read-Host "请输入备份 zip 完整路径"
          $zipPath = Sanitize-PathInput $zipPath
          if ($zipPath -and (Test-Path $zipPath)) {
            $confirm = Read-Host "确认覆盖当前配置? (y/N)"
            if ($confirm -eq 'y' -or $confirm -eq 'Y') {
              if (Restore-OpenClawConfig -ZipPath $zipPath) {
                Write-Host "`[OK`] 配置已恢复" -ForegroundColor Green
              } else {
                Write-Host "`[失败`] 恢复失败" -ForegroundColor Red
              }
            } else { Write-Host "已取消" -ForegroundColor DarkGray }
          } else {
            Write-Host "`[失败`] 文件不存在" -ForegroundColor Red
          }
          Pause-Wait
        } elseif ($toolChoice -eq "c") {
          Write-Host ""
          $out = Read-Host "导出保存目录 (默认: 用户目录)"
          $out = if ($out) { Sanitize-PathInput $out } else { "" }
          if (-not $out) { $out = $env:USERPROFILE }
          $fpath = Export-Diagnostic -OutDir $out
          if ($fpath) {
            Write-Host ("`[OK`] 诊断已导出: " + $fpath) -ForegroundColor Green
          } else {
            Write-Host "`[失败`] 导出失败" -ForegroundColor Red
          }
          Pause-Wait
        } elseif ($toolChoice -eq "e") {
          Write-Host ""
          Write-Host "--- 修复 Gateway 任务 ---" -ForegroundColor Yellow
          Write-Host "热迁移或删除源安装后，计划任务可能仍指向已删除的旧路径。" -ForegroundColor DarkGray
          Write-Host "此操作将: 停止 -> 删除旧任务 -> 重新注册 -> 启动" -ForegroundColor DarkGray
          Write-Host ""
          $script:GatewayCacheTime = $null
          Ensure-GatewayMode
          Run-OpenClaw "gateway stop" | Out-Null
          Start-Sleep -Seconds 2
          $del = schtasks /delete /tn "OpenClaw Gateway" /f 2>$null
          Start-Sleep -Seconds 1
          $env:OPENCLAW_STATE_DIR = Get-OpenClawConfigDir
          Run-OpenClaw "gateway install --force" | Out-Null
          Patch-GatewayCmdStateDir
          if ($LASTEXITCODE -eq 0) {
            Start-Sleep -Seconds 1
            if (Start-Gateway-Hidden) {
              Start-Sleep -Seconds 3
              if (Test-GatewayRunning) {
                Write-Host "`[OK`] Gateway 已修复并运行" -ForegroundColor Green
              } else {
                Write-Host "`[OK`] 任务已重新注册，请用选项 2 启动" -ForegroundColor Green
              }
            } else {
              Write-Host "`[OK`] 任务已重新注册，请用选项 2 启动 Gateway" -ForegroundColor Green
            }
          } else {
            Write-Host "`[失败`] 修复失败，请检查 openclaw 安装" -ForegroundColor Red
            Write-Host ""
            Write-Host "schtasks 创建失败常见原因:" -ForegroundColor Yellow
            Write-Host "  1. 以管理员身份运行 - 右键脚本 -> 以管理员身份运行" -ForegroundColor DarkGray
            Write-Host "  2. Administrator 无密码 - 计划任务需账户有密码，请为 Administrator 设置密码" -ForegroundColor DarkGray
            Write-Host "  3. 前台启动替代 - 新开 cmd 运行: openclaw gateway (保持窗口不关即可)" -ForegroundColor DarkGray
          }
          Pause-Wait
        } elseif ($toolChoice -eq "f") {
          Write-Host ""
          Write-Host "--- 前台启动 Gateway ---" -ForegroundColor Yellow
          Write-Host "将在新窗口启动 Gateway，不依赖计划任务。请保持该窗口不关闭。" -ForegroundColor DarkGray
          Write-Host ""
          $ocDir = Split-Path $OPENCLAW_CMD -Parent
          $cfgDir = Get-OpenClawConfigDir
          $cmdLine = "set `"OPENCLAW_STATE_DIR=$($cfgDir.Replace('"','""'))`" && openclaw gateway"
          try {
            Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $cmdLine -WorkingDirectory $ocDir
            Write-Host "`[OK`] 已在新窗口启动，Gateway 就绪后访问: http://127.0.0.1:18789/" -ForegroundColor Green
          } catch {
            Write-Host "`[提示`] 请手动新开 cmd 运行: openclaw gateway" -ForegroundColor Yellow
          }
          Pause-Wait
        } elseif ($toolChoice -eq "g") {
          Write-Host ""
          Write-Host "--- Skills 管理 ---" -ForegroundColor Yellow
          Write-Host "  [1] 列出 Skills (skills list)" -ForegroundColor White
          Write-Host "  [2] 检查依赖 (skills check)" -ForegroundColor White
          Write-Host "  [3] 一键安装/更新 Skills (onboard 非交互)" -ForegroundColor White
          Write-Host "  [0] 返回" -ForegroundColor White
          Write-Host ""
          $sk = Read-Host "请选择"
          $sk = if ($sk) { $sk.Trim() } else { "" }
          if ($sk -eq "1") {
            Ensure-ExtensionManifestCompat | Out-Null
            Run-OpenClaw "skills list" | Out-Null
          } elseif ($sk -eq "2") {
            Run-OpenClaw "skills check" | Out-Null
          } elseif ($sk -eq "3") {
            Write-Host "`[预处理`] manifest 补齐 + doctor --fix..." -ForegroundColor Cyan
            Ensure-ExtensionManifestCompat | Out-Null
            Run-OpenClaw "doctor --fix" 2>$null | Out-Null
            Write-Host "正在安装/更新 Skills..." -ForegroundColor Cyan
            $env:OPENCLAW_STATE_DIR = Get-OpenClawConfigDir
            $errOut = ""
            try {
              & $OPENCLAW_CMD onboard --non-interactive --accept-risk --mode local --auth-choice skip --node-manager npm --skip-channels --skip-daemon --skip-health --skip-ui 2>&1 | Tee-Object -Variable errOut | Out-Null
            } catch { $errOut = $_.Exception.Message }
            if ($LASTEXITCODE -eq 0) {
              Write-Host "`[OK`] Skills 已更新" -ForegroundColor Green
              Run-OpenClaw "skills check" | Out-Null
            } else {
              Write-Host "`[失败`] Skills 更新失败" -ForegroundColor Red
              Write-TicketSummary "Skills 安装/更新" $errOut | Out-Null
            }
          }
          Pause-Wait
        } elseif ($toolChoice -eq "h") {
          Invoke-MinimalRepair | Out-Null
          Pause-Wait
        } elseif ($toolChoice -eq "d") {
          Write-Host ""
          Write-Host "--- 代理设置 ---" -ForegroundColor Yellow
          $proxy = npm config get proxy 2>$null
          $httpsProxy = npm config get https-proxy 2>$null
          Write-Host ('当前 proxy: ' + $(if ($proxy) { $proxy } else { '(未设置)' })) -ForegroundColor DarkGray
          Write-Host ('当前 https-proxy: ' + $(if ($httpsProxy) { $httpsProxy } else { '(未设置)' })) -ForegroundColor DarkGray
          Write-Host ""
          Write-Host "  [1] 设置代理 - 配置 HTTP/HTTPS 代理地址" -ForegroundColor White
          Write-Host "  [2] 清除代理 - 移除代理配置" -ForegroundColor White
          Write-Host "  [0] 返回" -ForegroundColor White
          Write-Host ""
          $px = Read-Host "请选择"
          $px = if ($px) { $px.Trim() } else { "" }
          if ($px -eq "1") {
            $url = Read-Host "代理地址 (如 http://127.0.0.1:7890)"
            $url = if ($url) { Sanitize-PathInput $url } else { "" }
            if ($url) {
              npm config set proxy $url
              npm config set https-proxy $url
              Write-Host "`[OK`] 代理已设置" -ForegroundColor Green
            } else { Write-Host "`[取消`] 未输入" -ForegroundColor Yellow }
          } elseif ($px -eq "2") {
            npm config delete proxy 2>$null
            npm config delete https-proxy 2>$null
            Write-Host "`[OK`] 代理已清除" -ForegroundColor Green
          }
          Pause-Wait
        } else { Write-Host "无效输入" -ForegroundColor Yellow }
      }
    }
    "0" {
      Write-Host "已退出" -ForegroundColor Green
      exit 0
    }
    default {
      Write-Host "无效输入" -ForegroundColor Yellow
      Start-Sleep -Milliseconds 800
    }
  }
}
